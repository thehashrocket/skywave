"""One browser listener: owns a Kiwi connection and the DSP chain for it.

Browser -> service (JSON text frames):
    {"type": "tune", "host": "...", "port": 8073, "freqKhz": 9535, "mode": "am"}
    {"type": "stop"}

Service -> browser:
    JSON text: {"type": "status", "state": "connecting|listening|stopped|error", ...}
    JSON text: {"type": "meter", "rssi": -73.1, "overflow": false}
    Binary:    0x01 + float32 LE mono audio at `sampleRate`
    Binary:    0x02 + float32 LE dBFS bins spanning -sampleRate/2..+sampleRate/2
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from .config import Settings
from .dsp import CW_PITCH_HZ, MODES, Demodulator, Spectrum
from .hostguard import HostRejected, resolve_receiver
from .kiwi import DEFAULT_PORT, KiwiClient, KiwiError

log = logging.getLogger(__name__)

AUDIO_TAG = b"\x01"
SPECTRUM_TAG = b"\x02"
MAX_FREQ_KHZ = 32_000.0
METER_INTERVAL_S = 0.25

SendText = Callable[[dict[str, Any]], Awaitable[None]]
SendBytes = Callable[[bytes], Awaitable[None]]


class BadRequest(Exception):
    pass


class ClientGone(Exception):
    """The browser disconnected; stop quietly."""


def kiwi_freq_khz(freq_khz: float, mode: str) -> float:
    """Frequency to ask the Kiwi for. CW is offset so the signal lands at an audible pitch."""
    return freq_khz - CW_PITCH_HZ / 1000 if mode == "cw" else freq_khz


class ListenSession:
    def __init__(
        self,
        settings: Settings,
        send_text: SendText,
        send_bytes: SendBytes,
        *,
        resolver: Callable[..., Awaitable[str]] = resolve_receiver,
        client_factory: Callable[..., KiwiClient] = KiwiClient,
    ):
        self.settings = settings
        self._send_text = send_text
        self._send_bytes = send_bytes
        self._resolver = resolver
        self._client_factory = client_factory
        self._client: KiwiClient | None = None
        self._pump: asyncio.Task[None] | None = None
        self._demod: Demodulator | None = None
        self._spectrum: Spectrum | None = None
        self._mode = "am"
        self._freq_khz = 0.0
        self._target: tuple[str, int] | None = None

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
        host = str(msg.get("host", "")).strip()
        try:
            port = int(msg.get("port") or DEFAULT_PORT)
            freq = float(msg["freqKhz"])
        except (KeyError, TypeError, ValueError) as e:
            raise BadRequest("tune needs host, port and freqKhz.") from e
        mode = str(msg.get("mode", "am")).lower()
        if not host:
            raise BadRequest("Pick a receiver first.")
        if mode not in MODES:
            raise BadRequest(f"Mode must be one of {', '.join(MODES)}.")
        if not 0 < freq <= MAX_FREQ_KHZ:
            raise BadRequest("Frequency must be between 0 and 32,000 kHz.")

        self._freq_khz = freq
        same_receiver = self._target == (host, port) and self._pump is not None and not self._pump.done()
        if same_receiver and self._client is not None:
            if mode != self._mode:
                self._mode = mode
                if self._client.info.sample_rate:
                    self._demod = Demodulator(self._client.info.sample_rate, mode)
            await self._client.tune(kiwi_freq_khz(freq, mode))
            await self._status("listening")
            return

        await self.stop(None)
        self._mode = mode
        self._target = (host, port)
        self._pump = asyncio.create_task(self._run(host, port))

    async def _run(self, host: str, port: int) -> None:
        await self._status("connecting", host=host)
        try:
            ip = await self._resolver(host, port, allow_private=self.settings.allow_private_hosts)
            client = self._client_factory(
                host, port, connect_host=ip, user=self.settings.ident, kiwi_agc=self.settings.kiwi_agc
            )
            self._client = client
            await client.tune(kiwi_freq_khz(self._freq_khz, self._mode))
            info = await client.connect()
            assert info.sample_rate is not None
            self._demod = Demodulator(info.sample_rate, self._mode)
            self._spectrum = Spectrum(info.sample_rate)
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
                demod = self._demod
                audio = demod.process(block.samples)
                await self._send_bytes(AUDIO_TAG + audio.astype("<f4").tobytes())
                for frame in self._spectrum.process(block.samples):
                    await self._send_bytes(SPECTRUM_TAG + frame.db.astype("<f4").tobytes())
                now = time.monotonic()
                if now - last_meter >= METER_INTERVAL_S:
                    last_meter = now
                    await self._send_text(
                        {"type": "meter", "rssi": round(block.rssi_dbm, 1), "overflow": block.adc_overflow}
                    )
        except ClientGone:
            pass
        except HostRejected as e:
            await self._status("error", message=str(e))
        except KiwiError as e:
            await self._status("error", message=str(e), code=e.code)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("listen session crashed")
            await self._status("error", message="Something broke in the radio service. Check its logs.")
        finally:
            if self._client is not None:
                await self._client.close()
                self._client = None

    async def _status(self, state: str, **extra: Any) -> None:
        payload: dict[str, Any] = {"type": "status", "state": state, "mode": self._mode, "freqKhz": self._freq_khz}
        if self._target:
            payload["host"], payload["port"] = self._target
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
