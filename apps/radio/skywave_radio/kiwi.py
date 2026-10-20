"""Minimal async client for a KiwiSDR's audio (SND) stream in I/Q mode.

Protocol notes, cross-checked against jks-prv/kiwiclient:

* WebSocket at ws://host:port/<timestamp>/SND (wss:// for Kiwis behind HTTPS)
* Text commands are "SET ..." strings; the Kiwi answers with binary frames
  whose first three bytes are a tag: "MSG" (key=value status) or "SND" (audio).
* After "SET auth", wait for audio_rate (reply "SET AR OK") and sample_rate,
  then configure mode/frequency/AGC. Send "SET keepalive" about once a second
  or the Kiwi drops you.
* SND body: flags (u8), sequence (u32 LE), S-meter (u16 BE), then data. In
  I/Q mode (stereo flag set) data starts with a 10-byte GPS timestamp header,
  followed by interleaved big-endian int16 I,Q samples. I/Q is never
  compressed, but we also send "SET compression=0" to be explicit.
"""

from __future__ import annotations

import asyncio
import logging
import struct
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from urllib.parse import unquote, urljoin, urlsplit

import numpy as np
import websockets
from websockets.asyncio.client import ClientConnection
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import InvalidStatus
from websockets.uri import parse_uri

from .dsp import int16_iq_to_complex

log = logging.getLogger(__name__)

SND_FLAG_ADC_OVFL = 0x02
SND_FLAG_STEREO = 0x08
SND_FLAG_COMPRESSED = 0x10

GPS_HEADER_BYTES = 10
DEFAULT_PORT = 8073
HTTPS_PORT = 443
REDIRECT_STATUSES = {300, 301, 302, 303, 307, 308}

# Kiwis run at about 12 kHz (or 20.25 kHz in wideband mode). The receiver
# reports its rate and we size DSP and browser buffers from it, so a hostile
# one could otherwise ask us to allocate gigabytes.
MIN_RATE_HZ = 6_000.0
MAX_RATE_HZ = 48_000.0


class KiwiError(Exception):
    """A Kiwi refused or dropped us. `code` is machine-readable."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class IQBlock:
    seq: int
    rssi_dbm: float
    samples: np.ndarray  # complex64, scaled to [-1, 1)
    adc_overflow: bool


@dataclass
class KiwiInfo:
    sample_rate: float | None = None
    audio_rate: int | None = None
    freq_offset_khz: float = 0.0
    version: str | None = None
    extra: dict[str, str | None] = field(default_factory=dict)


def parse_msg(body: bytes) -> dict[str, str | None]:
    """Parse the body of a MSG frame: space-separated name[=urlencoded value]."""
    text = body.decode("utf-8", errors="replace").strip()
    params: dict[str, str | None] = {}
    for part in text.split(" "):
        if not part:
            continue
        if "=" in part:
            name, value = part.split("=", 1)
            params[name] = unquote(value)
        else:
            params[part] = None
    return params


def parse_snd(body: bytes) -> IQBlock:
    """Parse the body of a SND frame (everything after the 'SND' tag)."""
    if len(body) < 7:
        raise ValueError("SND frame too short")
    flags, seq = struct.unpack_from("<BI", body, 0)
    (smeter,) = struct.unpack_from(">H", body, 5)
    data = body[7:]
    if not flags & SND_FLAG_STEREO:
        raise ValueError("expected an I/Q (stereo) SND frame; is mode set to iq?")
    if flags & SND_FLAG_COMPRESSED:
        raise ValueError("I/Q frames should never be compressed")
    data = data[GPS_HEADER_BYTES:]
    usable = len(data) - (len(data) % 4)
    raw = np.frombuffer(data[:usable], dtype=">i2")
    return IQBlock(
        seq=seq,
        rssi_dbm=0.1 * smeter - 127.0,
        samples=int16_iq_to_complex(raw),
        adc_overflow=bool(flags & SND_FLAG_ADC_OVFL),
    )


class _connect(ws_connect):
    """websockets.connect that follows no redirects on its own.

    It would follow a same-host one silently, and refuses a cross-origin one
    (we always pass `host`) with a ValueError. KiwiClient.connect decides
    instead, so the one-hop, same-host, https-only rule holds for all of them.
    """

    def process_redirect(self, exc: Exception) -> Exception:
        return exc


def hostport(host: str, port: int) -> str:
    # An IPv6 literal needs brackets, or its colons read as the port.
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


class KiwiClient:
    """One I/Q listening channel on one KiwiSDR.

    Usage:
        client = KiwiClient("kiwi.example.org")
        await client.connect()
        await client.tune(9535.0)
        async for block in client.blocks():
            ...
        await client.close()
    """

    def __init__(
        self,
        host: str,
        port: int = DEFAULT_PORT,
        *,
        connect_host: str | None = None,
        secure: bool = False,
        user: str = "skywave",
        kiwi_agc: bool = True,
        passband_hz: tuple[int, int] = (-5000, 5000),
        timeout_s: float = 10.0,
    ):
        self.host = host
        self.port = port
        # wss://, with the certificate checked against `host` even though we
        # dial `connect_host`.
        self.secure = secure
        # Resolved address to actually dial (prevents DNS rebinding between
        # validation and connect). The URL still carries the real hostname.
        self.connect_host = connect_host or host
        self.user = user
        self.kiwi_agc = kiwi_agc
        self.passband_hz = passband_hz
        self.timeout_s = timeout_s
        self.info = KiwiInfo()
        self.freq_khz: float | None = None
        self._ws: ClientConnection | None = None
        self._last_keepalive = 0.0

    @property
    def hostport(self) -> str:
        return hostport(self.host, self.port)

    @property
    def url(self) -> str:
        scheme = "wss" if self.secure else "ws"
        return f"{scheme}://{self.hostport}/{int(time.time())}/SND"

    async def connect(self) -> KiwiInfo:
        try:
            await self._dial()
        except InvalidStatus as e:
            upgrade = self._https_upgrade(e)
            if upgrade is None:
                raise self._unreachable(e) from e
            # The same host on https: dial the address we already checked.
            self.secure, self.port = True, upgrade
            try:
                await self._dial()
            except InvalidStatus as e2:
                # Only one hop: a second redirect is refused like any other.
                raise self._unreachable(e2) from e2

        await self._send("SET auth t=kiwi p=")
        try:
            await asyncio.wait_for(self._handshake(), timeout=self.timeout_s)
        except asyncio.TimeoutError as e:
            await self.close()
            raise KiwiError("timeout", f"{self.host} never sent its sample rate") from e
        return self.info

    async def _dial(self) -> None:
        """Open the WebSocket, or raise KiwiError (InvalidStatus for a redirect)."""
        url = self.url
        try:
            parse_uri(url)
        except (websockets.InvalidURI, ValueError) as e:
            raise KiwiError("invalid", f"{self.hostport} isn't an address we can dial.") from e
        try:
            self._ws = await asyncio.wait_for(
                _connect(
                    url,
                    host=self.connect_host,
                    port=self.port,
                    # Never via a proxy from the environment: that would dial
                    # the name, not the address hostguard checked.
                    proxy=None,
                    max_size=2**20,
                    compression=None,
                    open_timeout=self.timeout_s,
                    ping_interval=None,  # the Kiwi has its own keepalive
                    user_agent_header="skywave",
                ),
                timeout=self.timeout_s,
            )
        except InvalidStatus as e:
            if e.response.status_code in REDIRECT_STATUSES:
                raise
            raise self._unreachable(e) from e
        except (OSError, asyncio.TimeoutError, websockets.InvalidHandshake) as e:
            raise self._unreachable(e) from e

    def _https_upgrade(self, e: InvalidStatus) -> int | None:
        """The port to redial over https, if `e` is a redirect we follow.

        Only the same host moving from ws to https, on 443 or the port it
        already uses; any other redirect could point us anywhere.
        """
        location = e.response.headers.get("Location")
        if self.secure or e.response.status_code not in REDIRECT_STATUSES or not location:
            return None
        target = urlsplit(urljoin(f"http://{self.hostport}/", location))
        try:
            port = target.port or HTTPS_PORT
        except ValueError:
            return None
        if target.scheme not in ("https", "wss") or (target.hostname or "") != self.host.lower():
            return None
        return port if port in (HTTPS_PORT, self.port) else None

    def _unreachable(self, e: BaseException) -> KiwiError:
        if isinstance(e, asyncio.TimeoutError):
            # A timeout's message is empty, which left the browser showing "()".
            reason = "no answer; check the port"
        elif isinstance(e, InvalidStatus) and e.response.status_code in REDIRECT_STATUSES:
            reason = f"it redirects to {e.response.headers.get('Location', 'somewhere else')}"
        else:
            reason = str(e) or type(e).__name__
        return KiwiError("unreachable", f"Couldn't connect to {self.hostport} ({reason})")

    async def _handshake(self) -> None:
        assert self._ws is not None
        while self.info.sample_rate is None:
            frame = await self._recv()
            if frame[:3] == b"MSG":
                await self._handle_msg(parse_msg(frame[4:]))

        # Setup sequence mirrors kiwiclient: squelch off, generator off,
        # name, mode, AGC, compression off, then keepalive.
        await self._send("SET squelch=0 max=0")
        await self._send("SET genattn=0")
        await self._send("SET gen=0 mix=-1")
        await self._send(f"SET ident_user={self.user}")
        if self.freq_khz is not None:
            await self._send_mod()
        if self.kiwi_agc:
            await self._send("SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50")
        else:
            await self._send("SET agc=0 hang=0 thresh=-100 slope=6 decay=1000 manGain=50")
        await self._send("SET compression=0")
        await self._keepalive(force=True)

    async def _handle_msg(self, params: dict[str, str | None]) -> None:
        for name, value in params.items():
            if name == "too_busy":
                raise KiwiError("busy", f"{self.host} is full ({value} channels in use). Try another receiver.")
            if name == "badp" and value not in (None, "0"):
                raise KiwiError("password", f"{self.host} requires a password.")
            if name == "down":
                raise KiwiError("down", f"{self.host} is down right now.")
            if name == "redirect":
                raise KiwiError("redirect", f"{self.host} redirected to {value}; use that address instead.")
            if name == "audio_rate" and value:
                self.info.audio_rate = int(self._checked_rate(value))
                await self._send(f"SET AR OK in={self.info.audio_rate} out=44100")
            elif name == "sample_rate" and value:
                self.info.sample_rate = self._checked_rate(value)
            elif name == "freq_offset" and value:
                self.info.freq_offset_khz = float(value)
            elif name == "version_maj":
                self.info.version = value
            else:
                self.info.extra[name] = value

    def _checked_rate(self, value: str) -> float:
        try:
            rate = float(value)
        except ValueError:
            rate = float("nan")
        # Written so NaN fails too: every comparison with NaN is False.
        if not MIN_RATE_HZ <= rate <= MAX_RATE_HZ:
            raise KiwiError("bad_rate", f"{self.host} reported an unsupported sample rate ({value}).")
        return rate

    async def tune(self, freq_khz: float) -> None:
        self.freq_khz = freq_khz
        if self._ws is not None and self.info.sample_rate is not None:
            await self._send_mod()

    async def _send_mod(self) -> None:
        assert self.freq_khz is not None
        low, high = self.passband_hz
        baseband = self.freq_khz - self.info.freq_offset_khz
        await self._send(f"SET mod=iq low_cut={low} high_cut={high} freq={baseband:.3f}")

    async def blocks(self) -> AsyncIterator[IQBlock]:
        if self._ws is None:
            raise RuntimeError("connect() first")
        while True:
            try:
                frame = await asyncio.wait_for(self._recv(), timeout=self.timeout_s)
            except asyncio.TimeoutError as e:
                raise KiwiError("timeout", f"{self.host} stopped sending audio") from e
            tag = frame[:3]
            if tag == b"SND":
                await self._keepalive()
                yield parse_snd(frame[3:])
            elif tag == b"MSG":
                await self._handle_msg(parse_msg(frame[4:]))

    async def _recv(self) -> bytes:
        assert self._ws is not None
        try:
            msg = await self._ws.recv()
        except websockets.ConnectionClosed as e:
            raise KiwiError("closed", f"{self.host} closed the connection") from e
        return msg if isinstance(msg, bytes) else msg.encode()

    async def _keepalive(self, force: bool = False) -> None:
        now = time.monotonic()
        if force or now - self._last_keepalive >= 1.0:
            self._last_keepalive = now
            await self._send("SET keepalive")

    async def _send(self, msg: str) -> None:
        if self._ws is None:
            return
        if msg != "SET keepalive":
            log.debug("-> %s: %s", self.host, msg)
        try:
            await self._ws.send(msg)
        except websockets.ConnectionClosed as e:
            raise KiwiError("closed", f"{self.host} closed the connection") from e

    async def close(self) -> None:
        if self._ws is not None:
            ws, self._ws = self._ws, None
            await ws.close()
