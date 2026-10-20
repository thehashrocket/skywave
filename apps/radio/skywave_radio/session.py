"""One browser listener: owns a Kiwi connection and the DSP chain for it.

Browser -> service (JSON text frames):
    {"type": "tune", "host": "...", "port": 8073, "freqKhz": 9535, "mode": "am", "source": "list", "secure": true}
    ("source": "list" marks a receiver the browser picked from the public list
    rather than one a person typed; those are only ever dialed on public
    addresses, even with ALLOW_PRIVATE_HOSTS on. "secure": true dials wss://.)
    {"type": "stop"}

Service -> browser:
    JSON text: {"type": "status", "state": "connecting|listening|stopped|error", ...}
               (an uncoded error may carry "retryAfterMs": the same receiver
               may work if tried again after that long)
    JSON text: {"type": "meter", "rssi": -73.1, "overflow": false}
    Binary:    0x03 + int16 LE mono audio at `sampleRate` (full scale = 32767)
    Binary:    0x04 + float32 LE base dB + uint8 bins spanning -sampleRate/2..+sampleRate/2,
               each bin base + v * 0.5 dB
    (0x01/0x02, the same with float32 samples and dB, are no longer sent; the
    browser still reads them so the web app can deploy before this service.)
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Hashable
from typing import Any

from .config import Settings
from .dsp import CW_PITCH_HZ, MODES, Demodulator, Spectrum, encode_audio, encode_spectrum
from .hostguard import HostRejected, is_public_address, resolve_receiver
from .kiwi import DEFAULT_PORT, KiwiClient, KiwiError

log = logging.getLogger(__name__)

AUDIO_TAG = b"\x03"
SPECTRUM_TAG = b"\x04"
MAX_FREQ_KHZ = 32_000.0
METER_INTERVAL_S = 0.25
# A browser that stops reading (frozen tab, dead Wi-Fi) blocks our sends; past
# this we give up on it so it stops holding a slot and a volunteer's channel.
# Long enough to ride out a Wi-Fi roam or a laptop waking up.
SEND_TIMEOUT_S = 15.0

SendText = Callable[[dict[str, Any]], Awaitable[None]]
SendBytes = Callable[[bytes], Awaitable[None]]


class BadRequest(Exception):
    pass


class ClientGone(Exception):
    """The browser disconnected; stop quietly."""


class Slots:
    """Caps live Kiwi connections across every browser session.

    Each one occupies a channel on a volunteer's receiver, so that's what we
    count. No lock: acquire and release never await, and everything runs on
    one event loop.
    """

    def __init__(self, limit: int):
        self.limit = limit
        self.active = 0

    def try_acquire(self) -> bool:
        if self.active >= self.limit:
            return False
        self.active += 1
        return True

    def release(self) -> None:
        self.active -= 1


def kiwi_freq_khz(freq_khz: float, mode: str) -> float:
    """Frequency to ask the Kiwi for. CW is offset so the signal lands at an audible pitch."""
    return freq_khz - CW_PITCH_HZ / 1000 if mode == "cw" else freq_khz


class ListenSession:
    """One browser's listening session.

    A tune for a new receiver takes a slot and starts a pump task:

        connecting ──handshake──▶ listening ──limit/error/stop──▶ ended
                                                                  (slot released)

    A tune for the same receiver while the pump is alive is always a retune,
    never a restart. Before the handshake finishes it only records the new
    frequency and mode, which the handshake then applies.
    """

    def __init__(
        self,
        settings: Settings,
        send_text: SendText,
        send_bytes: SendBytes,
        *,
        slots: Slots | None = None,
        resolver: Callable[..., Awaitable[str]] = resolve_receiver,
        client_factory: Callable[..., KiwiClient] = KiwiClient,
        client_ip: str | None = None,
        on_stalled: Callable[[], None] | None = None,
    ):
        self.settings = settings
        self._raw_send_text = send_text
        self._raw_send_bytes = send_bytes
        self._slots = slots or Slots(settings.max_sessions)
        self._resolver = resolver
        self._client_factory = client_factory
        self._client_ip = client_ip
        self._on_stalled = on_stalled
        self._client: KiwiClient | None = None
        self._pump: asyncio.Task[None] | None = None
        # The pump whose end releases this session's slot. Switching receivers
        # hands the slot to the new pump instead of releasing and re-taking it,
        # which another listener could win in between.
        self._slot_holder: asyncio.Task[None] | None = None
        self._demod: Demodulator | None = None
        self._spectrum: Spectrum | None = None
        self._mode = "am"
        self._freq_khz = 0.0
        # host, port, whether private addresses may be dialed for it, and wss.
        self._target: tuple[str, int, bool, bool] | None = None
        self._listening = False

    @property
    def lookup_owner(self) -> Hashable:
        """Who hostguard's one-lookup-at-a-time limit applies to.

        The client's IP when it's public, so opening more sockets doesn't get
        more lookups. Behind a proxy the service doesn't trust (see
        FORWARDED_ALLOW_IPS), every listener shares the proxy's private
        address, so fall back to this session rather than lump them together.
        """
        if self._client_ip and is_public_address(self._client_ip):
            return ("ip", self._client_ip)
        return self

    async def _send_text(self, payload: dict[str, Any]) -> None:
        await self._send_or_give_up(self._raw_send_text(payload))

    async def _send_bytes(self, data: bytes) -> None:
        await self._send_or_give_up(self._raw_send_bytes(data))

    async def _send_or_give_up(self, send: Awaitable[None]) -> None:
        try:
            await asyncio.wait_for(send, SEND_TIMEOUT_S)
        except asyncio.TimeoutError as e:
            log.info("browser stopped reading for %gs; ending its session", SEND_TIMEOUT_S)
            if self._on_stalled is not None:
                self._on_stalled()
            raise ClientGone() from e

    async def handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        try:
            if kind == "tune":
                await self._tune(msg)
            elif kind == "stop":
                await self.stop("Stopped.")
            else:
                raise BadRequest(f"Unknown message type {kind!r}.")
        except BadRequest as e:
            await self._status("error", message=str(e))

    async def _tune(self, msg: dict[str, Any]) -> None:
        # Lowercased like the resolver does, so Kiwi.Example and kiwi.example
        # are the same receiver and a retune doesn't reconnect.
        host = str(msg.get("host", "")).strip().lower()
        try:
            port = int(msg.get("port") or DEFAULT_PORT)
            freq = float(msg["freqKhz"])
        except (KeyError, TypeError, ValueError, OverflowError) as e:
            # OverflowError: JSON like "port": 1e999 parses to inf, and int(inf) overflows.
            raise BadRequest("tune needs host, port and freqKhz.") from e
        mode = str(msg.get("mode", "am")).lower()
        if not host:
            raise BadRequest("Pick a receiver first.")
        if mode not in MODES:
            raise BadRequest(f"Mode must be one of {', '.join(MODES)}.")
        if not 0 < freq <= MAX_FREQ_KHZ:
            raise BadRequest("Frequency must be between 0 and 32,000 kHz.")

        self._freq_khz = freq
        public_only = msg.get("source") == "list"
        secure = msg.get("secure") is True
        # Same receiver means same address dialed under the same rule: a list
        # tune of an address a typed tune reached privately must restart, but
        # with private hosts off (production) the two are one receiver.
        target = (host, port, self.settings.allow_private_hosts and not public_only, secure)
        same_receiver = self._target == target and self._pump is not None and not self._pump.done()
        if same_receiver:
            if mode != self._mode:
                self._mode = mode
                if self._listening:
                    self._demod = Demodulator(self._client.info.sample_rate, mode)
            # Still resolving: _run reads _freq_khz/_mode when it builds the client.
            if self._client is not None:
                try:
                    await self._client.tune(kiwi_freq_khz(freq, mode))
                except KiwiError:
                    # The Kiwi just dropped us; the pump sees the same failure
                    # and reports it, so don't send a second error.
                    return
            if self._listening:
                await self._status("listening")
            return

        # Keep the slot the old pump holds: its done callback then releases nothing.
        handing_over = self._slot_holder is not None
        self._slot_holder = None
        try:
            await self.stop(None)
        except BaseException:
            if handing_over:
                self._slots.release()
            raise
        if not handing_over and not self._slots.try_acquire():
            raise BadRequest("The radio service is at its listener limit. Try again in a bit.")
        self._mode = mode
        self._target = target
        self._pump = self._slot_holder = asyncio.create_task(
            self._run(host, port, public_only=public_only, secure=secure)
        )
        # A done callback, not a finally in _run: a task cancelled before it
        # first runs never enters its body.
        self._pump.add_done_callback(self._pump_done)

    def _pump_done(self, pump: asyncio.Task[None]) -> None:
        if pump is self._slot_holder:
            self._slot_holder = None
            self._slots.release()

    async def _run(self, host: str, port: int, *, public_only: bool = False, secure: bool = False) -> None:
        await self._status("connecting", host=host)
        try:
            allow_private = self.settings.allow_private_hosts and not public_only
            ip = await self._resolver(host, port, allow_private=allow_private, owner=self.lookup_owner)
            client = self._client_factory(
                host, port, connect_host=ip, secure=secure, user=self.settings.ident, kiwi_agc=self.settings.kiwi_agc
            )
            self._client = client
            await client.tune(kiwi_freq_khz(self._freq_khz, self._mode))
            info = await client.connect()
            assert info.sample_rate is not None
            self._demod = Demodulator(info.sample_rate, self._mode)
            self._spectrum = Spectrum(info.sample_rate)
            self._listening = True
            await self._status("listening")

            started = time.monotonic()
            limit_s = self.settings.max_session_minutes * 60
            last_meter = 0.0
            async for block in client.blocks():
                if time.monotonic() - started > limit_s:
                    await self._status(
                        "stopped",
                        message=f"Hit the {self.settings.max_session_minutes:g}-minute session limit. "
                        "Reconnect if you're still listening.",
                    )
                    return
                audio = self._demod.process(block.samples)
                await self._send_bytes(AUDIO_TAG + encode_audio(audio))
                for frame in self._spectrum.process(block.samples):
                    await self._send_bytes(SPECTRUM_TAG + encode_spectrum(frame.db))
                now = time.monotonic()
                if now - last_meter >= METER_INTERVAL_S:
                    last_meter = now
                    await self._send_text(
                        {"type": "meter", "rssi": round(block.rssi_dbm, 1), "overflow": block.adc_overflow}
                    )
        except ClientGone:
            pass
        except HostRejected as e:
            await self._status("error", message=str(e), code=e.code, retryAfterMs=e.retry_after_ms)
        except KiwiError as e:
            await self._status("error", message=str(e), code=e.code)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("listen session crashed")
            await self._status("error", message="Something broke in the radio service. Check its logs.")
        finally:
            self._listening = False
            if self._client is not None:
                await self._client.close()
                self._client = None

    async def _status(self, state: str, **extra: Any) -> None:
        payload: dict[str, Any] = {"type": "status", "state": state, "mode": self._mode, "freqKhz": self._freq_khz}
        if self._target:
            payload["host"], payload["port"], _, _ = self._target
        if self._client is not None and self._client.info.sample_rate:
            payload["sampleRate"] = self._client.info.sample_rate
        payload.update({k: v for k, v in extra.items() if v is not None})
        try:
            await self._send_text(payload)
        except Exception:
            # The browser went away; nothing useful to do.
            pass

    async def stop(self, message: str | None) -> None:
        if self._pump is not None and not self._pump.done():
            self._pump.cancel()
            try:
                await self._pump
            except asyncio.CancelledError:
                pass
        self._pump = None
        self._target = None
        if self._client is not None:
            await self._client.close()
            self._client = None
        if message:
            await self._status("stopped", message=message)

    async def close(self) -> None:
        await self.stop(None)
