"""Minimal async client for a KiwiSDR's audio (SND) stream in I/Q mode.

Protocol notes, cross-checked against jks-prv/kiwiclient:

* WebSocket at ws://host:port/kiwi/<timestamp>/SND (wss:// for Kiwis behind
  HTTPS). Current firmware accepts the bare /<timestamp>/SND upgrade but then
  never sends a frame; /kiwi/ works on old and new firmware alike.
* The timestamp pairs streams: a waterfall (W/F, see waterfall.py) opened
  with the audio's timestamp joins its channel, while one with another
  timestamp from the same listener is refused with badp=5.
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
# How long close() waits for the Kiwi's half of the closing handshake. When
# we stop reading (a stalled browser stops the pump), the Kiwi's audio fills
# our queue and its close reply sits behind it, so this is how long the
# channel and our listener slot outlive a dead tab. websockets' default is 10 s.
CLOSE_TIMEOUT_S = 2.0
REDIRECT_STATUSES = {300, 301, 302, 303, 307, 308}

# Kiwis run at about 12 kHz (or 20.25 kHz in wideband mode). The receiver
# reports its rate and we size DSP and browser buffers from it, so a hostile
# one could otherwise ask us to allocate gigabytes.
MIN_RATE_HZ = 6_000.0
MAX_RATE_HZ = 48_000.0

# blocks() times out unless this share of each timeout_s window is audio:
# 1 s in 10 s. Catches a receiver trickling 1-sample blocks, and leaves room
# for a slow link that recovers.
MIN_AUDIO_FRACTION = 0.1

# The largest frame we take from a Kiwi: 1 MiB, so at most 2**18 I/Q pairs,
# each sent on as one audio sample. MAX_AUDIO_SAMPLES in the web app's
# use-radio.ts must stay at least that, or it drops audio we sent.
MAX_FRAME_BYTES = 2**20


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
    (we always pass `host`) with a ValueError. KiwiConnection.connect decides
    instead, so the one-hop, same-host, https-only rule holds for all of them.
    """

    def process_redirect(self, exc: Exception) -> Exception:
        return exc


def hostport(host: str, port: int) -> str:
    # An IPv6 literal needs brackets, or its colons read as the port.
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


class KiwiConnection:
    """One WebSocket stream to one KiwiSDR: dialing, refusals, keepalive, close.

    Subclasses name the stream and do its handshake. Dialing rules (the
    address hostguard checked, no proxy, one same-host https upgrade) are
    the same for every stream.
    """

    STREAM = ""
    # What the handshake is still waiting for when it times out after the Kiwi answered.
    HANDSHAKE_WANTS = "its setup"
    # Whether a handshake that times out after the Kiwi answered closes the
    # stream. A paired waterfall must not: closing it ends the listener's audio.
    CLOSE_ON_LATE_HANDSHAKE = True
    # The last generated URL timestamp, shared by every connection in the process.
    _last_timestamp = 0

    def __init__(
        self,
        host: str,
        port: int = DEFAULT_PORT,
        *,
        connect_host: str | None = None,
        secure: bool = False,
        user: str = "skywave",
        timeout_s: float = 10.0,
        timestamp: int | None = None,
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
        self.timeout_s = timeout_s
        # In the URL; streams sharing it share a channel on the Kiwi. Unique
        # within the service: every listener reaches a Kiwi from our one
        # address, so two connections in the same second would otherwise pair
        # one listener's scan with another listener's audio.
        if timestamp is None:
            timestamp = max(int(time.time()), KiwiConnection._last_timestamp + 1)
            KiwiConnection._last_timestamp = timestamp
        self.timestamp = timestamp
        self.info = KiwiInfo()
        self._ws: ClientConnection | None = None
        self._last_keepalive = 0.0
        # Whether the Kiwi has sent anything since we sent auth.
        self._answered = False

    @property
    def hostport(self) -> str:
        return hostport(self.host, self.port)

    @property
    def url(self) -> str:
        scheme = "wss" if self.secure else "ws"
        return f"{scheme}://{self.hostport}/kiwi/{self.timestamp}/{self.STREAM}"

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
            if not self._answered or self.CLOSE_ON_LATE_HANDSHAKE:
                await self.close()
            if not self._answered:
                raise KiwiError("timeout", f"{self.host} connected but never answered") from e
            raise KiwiError("timeout", f"{self.host} never sent {self.HANDSHAKE_WANTS}") from e
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
                    max_size=MAX_FRAME_BYTES,
                    compression=None,
                    open_timeout=self.timeout_s,
                    close_timeout=CLOSE_TIMEOUT_S,
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
        raise NotImplementedError

    def _check_refusal(self, name: str, value: str | None) -> None:
        """Raise the KiwiError a refusal MSG means; any stream can get these."""
        if name == "too_busy":
            # The value is the receiver's channel count. 0 is how a Kiwi
            # whose owner allows no connections but its own web page
            # (ext_api=0 in the public list) turns us away, about 10 s in.
            if value == "0":
                raise KiwiError(
                    "no_apps",
                    f"{self.host} only lets listeners in through its own web page, "
                    "not apps like this one. Try another receiver.",
                )
            most = f" ({value} listeners max)" if value else ""
            raise KiwiError("busy", f"{self.host} is full{most}. Try another receiver.")
        if name == "badp" and value == "5":
            # A second stream from the same listener under another timestamp.
            raise KiwiError("busy", f"{self.host} refused another connection from this listener.")
        if name == "badp" and value not in (None, "0"):
            raise KiwiError("password", f"{self.host} requires a password.")
        if name == "down":
            raise KiwiError("down", f"{self.host} is down right now.")
        if name == "redirect":
            raise KiwiError("redirect", f"{self.host} redirected to {value}; use that address instead.")

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
            # A Kiwi that stops reading would block this forever once the
            # socket buffers fill, and no deadline in blocks() runs meanwhile.
            await asyncio.wait_for(self._ws.send(msg), timeout=self.timeout_s)
        except asyncio.TimeoutError as e:
            raise KiwiError("timeout", f"{self.host} stopped reading") from e
        except websockets.ConnectionClosed as e:
            raise KiwiError("closed", f"{self.host} closed the connection") from e

    async def close(self) -> None:
        if self._ws is not None:
            ws, self._ws = self._ws, None
            # ws.close() first waits, with no timeout, for our send buffer to
            # drain, so a Kiwi that stopped reading would hang it and keep the
            # listener slot. Give up after CLOSE_TIMEOUT_S and drop the socket.
            try:
                await asyncio.wait_for(ws.close(), timeout=CLOSE_TIMEOUT_S)
            except asyncio.TimeoutError:
                ws.transport.abort()
            except asyncio.CancelledError:
                ws.transport.abort()
                raise


class KiwiClient(KiwiConnection):
    """One I/Q listening channel on one KiwiSDR.

    Usage:
        client = KiwiClient("kiwi.example.org")
        await client.connect()
        await client.tune(9535.0)
        async for block in client.blocks():
            ...
        await client.close()
    """

    STREAM = "SND"
    HANDSHAKE_WANTS = "its sample rate"

    def __init__(
        self,
        host: str,
        port: int = DEFAULT_PORT,
        *,
        kiwi_agc: bool = True,
        passband_hz: tuple[int, int] = (-5000, 5000),
        **kwargs,
    ):
        super().__init__(host, port, **kwargs)
        self.kiwi_agc = kiwi_agc
        self.passband_hz = passband_hz
        self.freq_khz: float | None = None

    async def _handshake(self) -> None:
        assert self._ws is not None
        while self.info.sample_rate is None:
            frame = await self._recv()
            self._answered = True
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
            self._check_refusal(name, value)
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
        """SND blocks as they arrive, empty ones included.

        Raises a timeout unless MIN_AUDIO_FRACTION of each timeout_s window
        is real audio. MSG frames and short or empty SND blocks don't count,
        or a broken receiver could hold a listener slot while sending none.
        The time the caller spends on a block doesn't count either, so a
        stalled browser isn't blamed on the receiver.
        """
        if self._ws is None:
            raise RuntimeError("connect() first")
        assert self.info.sample_rate is not None
        needed = self.info.sample_rate * self.timeout_s * MIN_AUDIO_FRACTION
        got = 0
        deadline = time.monotonic() + self.timeout_s
        while True:
            # Our own work (a keepalive send, parsing) can use up the window
            # while the Kiwi's next frame is already queued. That frame still
            # gets read, but past the deadline it is the receiver's last
            # chance: unless it brings the window up to the floor, we time out.
            # wait_for(..., 0) would raise without reading it at all.
            remaining = deadline - time.monotonic()
            overdue = remaining <= 0
            try:
                async with asyncio.timeout(max(0.0, remaining)):
                    frame = await self._recv()
            except asyncio.TimeoutError as e:
                raise self._stopped() from e
            tag = frame[:3]
            if tag == b"SND":
                block = parse_snd(frame[3:])
                got += block.samples.size
                if got < needed and overdue:
                    raise self._stopped()
                await self._keepalive()
                if got >= needed:
                    # After the keepalive, so our own send time isn't taken
                    # out of the receiver's next window.
                    got = 0
                    deadline = time.monotonic() + self.timeout_s
                yielded_at = time.monotonic()
                yield block
                # Push the deadline out by however long the caller sat on the block.
                deadline += time.monotonic() - yielded_at
            elif overdue:
                # Not before handling it: an audio_rate MSG makes us send, and
                # a Kiwi that stopped reading would hold the slot through that.
                raise self._stopped()
            elif tag == b"MSG":
                await self._handle_msg(parse_msg(frame[4:]))

    def _stopped(self) -> KiwiError:
        return KiwiError("timeout", f"{self.host} stopped sending audio")

