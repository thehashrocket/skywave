"""One browser listener: owns a Kiwi connection and the DSP chain for it.

Browser -> service (JSON text frames):
    {"type": "tune", "host": "...", "port": 8073, "freqKhz": 9535, "mode": "am", "source": "list", "secure": true}
    ("source": "list" marks a receiver the browser picked from the public list
    rather than one a person typed; those are only ever dialed on public
    addresses, even with ALLOW_PRIVATE_HOSTS on. "secure": true dials wss://.)
    {"type": "stop"}
    {"type": "scan", "id": 3, "fresh": false}
    (scan the receiver being listened to for strong broadcast signals; "fresh"
    skips the 10-minute cache. Send it only to a service whose status lists
    "scan" in "features": an older one answers it with a status error.)

Service -> browser:
    JSON text: {"type": "status", "state": "connecting|listening|stopped|error", "features": ["scan"], ...}
               (an uncoded error may carry "retryAfterMs": the same receiver
               may work if tried again after that long)
    JSON text: {"type": "scan", "id": 3, "host": "...", "port": 8073, "state": "scanning|done|error", ...}
               (done: "signals" [{"freqKhz", "snrDb", "band"}] strongest first,
               "hidden" flat-topped signals left out, "bandsDone", "bandsTotal",
               "partial", "atMs"; error: "message". Scan failures never come as
               a status: listening goes on. id, host and port echo the request,
               so a late reply for another receiver or request can be ignored.)
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
from dataclasses import replace
from typing import Any

from .config import Settings
from .dsp import CW_PITCH_HZ, MODES, Demodulator, Spectrum, encode_audio, encode_spectrum
from .hostguard import HostRejected, is_public_address, resolve_receiver
from .kiwi import DEFAULT_PORT, KiwiClient, KiwiError
from .scan import ScanResult, sweep
from .waterfall import WaterfallClient

log = logging.getLogger(__name__)

AUDIO_TAG = b"\x03"
SPECTRUM_TAG = b"\x04"
MAX_FREQ_KHZ = 32_000.0
METER_INTERVAL_S = 0.25
# A browser that stops reading (frozen tab, dead Wi-Fi) blocks our sends; past
# this we give up on it so it stops holding a slot and a volunteer's channel.
# Long enough to ride out a Wi-Fi roam or a laptop waking up.
SEND_TIMEOUT_S = 15.0

# Statuses list what this service can do, so a newer web app knows whether to ask.
FEATURES = ["scan"]
# How long a receiver's scan is reused before a new one is made.
SCAN_CACHE_S = 600.0

# A receiver as the session dials it: host, port, whether private addresses
# may be dialed for it, and wss.
Target = tuple[str, int, bool, bool]

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


class ScanCache:
    """Recent scans per receiver, shared by every session for SCAN_CACHE_S."""

    def __init__(self, ttl_s: float = SCAN_CACHE_S):
        self.ttl_s = ttl_s
        self._entries: dict[Hashable, tuple[float, ScanResult]] = {}

    def get(self, key: Hashable) -> ScanResult | None:
        entry = self._entries.get(key)
        if entry is None or time.monotonic() - entry[0] > self.ttl_s:
            return None
        return entry[1]

    def put(self, key: Hashable, result: ScanResult) -> None:
        now = time.monotonic()
        # Pruned here so a long-running service doesn't keep every receiver it ever scanned.
        self._entries = {k: e for k, e in self._entries.items() if now - e[0] <= self.ttl_s}
        self._entries[key] = (now, result)


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
        scan_cache: ScanCache | None = None,
        resolver: Callable[..., Awaitable[str]] = resolve_receiver,
        client_factory: Callable[..., KiwiClient] = KiwiClient,
        waterfall_factory: Callable[..., WaterfallClient] = WaterfallClient,
        client_ip: str | None = None,
        on_stalled: Callable[[], None] | None = None,
    ):
        self.settings = settings
        self._raw_send_text = send_text
        self._raw_send_bytes = send_bytes
        self._slots = slots or Slots(settings.max_sessions)
        self._scan_cache = scan_cache or ScanCache()
        self._resolver = resolver
        self._client_factory = client_factory
        self._waterfall_factory = waterfall_factory
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
        self._target: Target | None = None
        self._listening = False
        # The band scan's waterfall, paired with self._client. It shares that
        # channel and closing it ends the audio, so once opened it idles until
        # the receiver connection ends (_end_scan), and uses no slot.
        self._waterfall: WaterfallClient | None = None
        self._waterfall_idle: asyncio.Task[None] | None = None
        self._scan: asyncio.Task[None] | None = None
        # The newest scan request's id; a running scan answers under it.
        self._scan_id: int | None = None

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
            elif kind == "scan":
                await self._start_scan(msg)
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
            # blocks() raises when the receiver goes quiet, so this loop (and
            # the limit check) comes round at least every timeout_s.
            async for block in client.blocks():
                if time.monotonic() - started > limit_s:
                    await self._status(
                        "stopped",
                        message=f"Hit the {self.settings.max_session_minutes:g}-minute session limit. "
                        "Reconnect if you're still listening.",
                    )
                    return
                # A short SND block has no samples: the demodulator's filter
                # can't take an empty array, and there's nothing to send.
                # blocks() times out a receiver that only sends these.
                if not block.samples.size:
                    continue
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
            # This pump is done with its receiver even while close() below
            # waits, so a tune for it now must start over, not retune a dead client.
            self._target = None
            if self._client is not None:
                await self._client.close()
                self._client = None
            await self._end_scan()

    async def _status(self, state: str, **extra: Any) -> None:
        payload: dict[str, Any] = {
            "type": "status",
            "state": state,
            "mode": self._mode,
            "freqKhz": self._freq_khz,
            "features": FEATURES,
        }
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
        # A cancel aimed at our caller (the browser left mid-switch) still
        # propagates, or the switch would go on to dial a receiver for nobody.
        await self._cancel(self._pump)
        self._pump = None
        self._target = None
        if self._client is not None:
            await self._client.close()
            self._client = None
        await self._end_scan()
        if message:
            await self._status("stopped", message=message)

    async def close(self) -> None:
        await self.stop(None)

    async def _start_scan(self, msg: dict[str, Any]) -> None:
        scan_id = msg.get("id")
        if not isinstance(scan_id, int) or isinstance(scan_id, bool):
            scan_id = None
        target, client = self._target, self._client
        if not self._listening or target is None or client is None:
            await self._scan_reply(scan_id, target, "error", message="Start listening to a receiver first.")
            return
        self._scan_id = scan_id
        if self._scan is not None and not self._scan.done():
            # Already sweeping this receiver: that sweep answers this request.
            # Cancelling it could close a half-open paired waterfall, which
            # takes the audio down with it.
            await self._scan_reply(scan_id, target, "scanning")
            return
        self._scan = asyncio.create_task(self._run_scan(target, client, fresh=msg.get("fresh") is True))

    async def _run_scan(self, target: Target, client: KiwiClient, *, fresh: bool) -> None:
        cached = None if fresh else self._scan_cache.get(target)
        if cached is not None:
            await self._finish(target, "done", **scan_payload(cached))
            return
        await self._scan_reply(self._scan_id, target, "scanning")
        try:
            waterfall = await self._paired_waterfall(client)
            result = await sweep(waterfall.frame, waterfall.info.freq_offset_khz, waterfall.bandwidth_khz)
        except KiwiError as e:
            await self._drop_waterfall()
            await self._finish(target, "error", message=f"Couldn't scan this receiver: {e}")
            return
        except Exception:
            log.exception("scan crashed")
            # Keep any waterfall drained: a dropped one takes the audio with it.
            self._idle_waterfall()
            await self._finish(target, "error", message="The scan broke. Check the radio service's logs.")
            return
        self._idle_waterfall()
        result = replace(result, at_ms=int(time.time() * 1000))
        self._scan_cache.put(target, result)
        await self._finish(target, "done", **scan_payload(result))

    async def _finish(self, target: Target, state: str, **extra: Any) -> None:
        """The scan's last reply, under the newest request's id.

        The scan stops counting as running first, so a request arriving while
        this reply is sent starts a new scan instead of waiting on this one.
        """
        if self._scan is asyncio.current_task():
            self._scan = None
        await self._scan_reply(self._scan_id, target, state, **extra)

    def _idle_waterfall(self) -> None:
        if self._waterfall is not None and (self._waterfall_idle is None or self._waterfall_idle.done()):
            self._waterfall_idle = asyncio.create_task(self._idle(self._waterfall))

    async def _paired_waterfall(self, client: KiwiClient) -> WaterfallClient:
        # Wait for the idle reader to finish: its recv would collide with the sweep's.
        await self._cancel(self._waterfall_idle)
        self._waterfall_idle = None
        if self._waterfall is not None:
            await self._waterfall.fast()
            return self._waterfall
        waterfall = self._waterfall_factory(
            client.host,
            client.port,
            connect_host=client.connect_host,
            secure=client.secure,
            user=self.settings.ident,
            # Same timestamp: joins the audio's channel instead of being refused.
            timestamp=client.timestamp,
        )
        try:
            await waterfall.connect()
        except BaseException:
            # Failed or cancelled (Scan again) mid-handshake: never reuse a half-open one.
            await waterfall.close()
            raise
        self._waterfall = waterfall
        return waterfall

    async def _idle(self, waterfall: WaterfallClient) -> None:
        try:
            await waterfall.idle()
        except KiwiError as e:
            # The audio pump reports it if the Kiwi took the audio down too.
            log.info("scan waterfall ended: %s", e)
            if self._waterfall is waterfall:
                self._waterfall = None
            # Closed too, so a send that timed out doesn't leave the socket behind.
            await waterfall.close()

    async def _drop_waterfall(self) -> None:
        waterfall, self._waterfall = self._waterfall, None
        if waterfall is not None:
            await waterfall.close()

    async def _end_scan(self) -> None:
        """Stop any scan and close its waterfall; the receiver connection has ended."""
        await self._cancel(self._scan)
        await self._cancel(self._waterfall_idle)
        self._scan = self._waterfall_idle = None
        await self._drop_waterfall()

    @staticmethod
    async def _cancel(task: asyncio.Task[None] | None) -> None:
        if task is None or task.done() or task is asyncio.current_task():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            # Ours ends here; a cancel aimed at our caller must not be swallowed.
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                raise

    async def _scan_reply(self, scan_id: int | None, target: Target | None, state: str, **extra: Any) -> None:
        payload: dict[str, Any] = {"type": "scan", "id": scan_id, "state": state}
        if target is not None:
            payload["host"], payload["port"], _, _ = target
        payload.update(extra)
        try:
            await self._send_text(payload)
        except Exception:
            pass


def scan_payload(result: ScanResult) -> dict[str, Any]:
    return {
        "signals": result.signals,
        "hidden": result.hidden,
        "bandsDone": result.bands_done,
        "bandsTotal": result.bands_total,
        "partial": result.partial,
        "atMs": result.at_ms,
    }
