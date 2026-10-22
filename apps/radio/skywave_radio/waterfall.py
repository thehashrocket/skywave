"""Async client for a KiwiSDR's waterfall (W/F) stream, used by the band scan.

Protocol notes, cross-checked against jks-prv/kiwiclient and live Kiwis
(2026-10-22):

* WebSocket at ws://host:port/kiwi/<timestamp>/W/F. Opened beside our own
  SND stream it must carry the SND's timestamp: it then shares that channel,
  and one with another timestamp is refused with badp=5. Closing it ends the
  paired SND too, so it stays open until the listener stops (idle()).
* After "SET auth" the Kiwi sends MSG frames ending with wf_setup; they carry
  freq_offset (kHz) and bandwidth (Hz), the receiver's coverage.
* "SET zoom=<z> cf=<kHz>" points it at bandwidth/2^z kHz centred on cf
  (baseband, i.e. RF minus freq_offset). W/F frames are the tag, one byte,
  a 12-byte header (x_bin, flags|zoom, seq as little-endian u32) and one byte
  per bin, about 1 dB per step (uncompressed with "SET wf_comp=0"). x_bin is
  the frame's start in 1/(1024 * 2^14) of the bandwidth. Frames for the
  previous zoom keep coming for a moment after a change.
"""

from __future__ import annotations

import asyncio
import math
import struct
from dataclasses import dataclass

import numpy as np
from websockets.protocol import State

from .kiwi import MAX_EXTRA_KEYS, KiwiConnection, KiwiError, parse_msg

WF_BINS = 1024
MAX_ZOOM = 14
HEADER_BYTES = 12
FAST_SPEED = 4  # about 23 frames a second while sweeping
IDLE_SPEED = 1  # about 1 a second while held open after a sweep
# A frame counts as the one asked for when its start is within this share of its span.
START_TOLERANCE = 0.02
# How often idle() sends a keepalive when no frame arrives.
KEEPALIVE_S = 1.0
# The coverage a receiver may report (real Kiwis report about 30 MHz); anything
# outside is ignored. Too narrow would crowd every peak of a sweep into a few kHz.
MIN_BANDWIDTH_KHZ = 1_000.0
MAX_BANDWIDTH_KHZ = 64_000.0


@dataclass
class WaterfallFrame:
    zoom: int
    start_khz: float  # baseband, like cf
    span_khz: float
    bins: np.ndarray  # uint8, about 1 dB per step


def parse_wf(body: bytes, bandwidth_khz: float) -> WaterfallFrame:
    """Parse the body of a W/F frame (everything after the 'W/F' tag)."""
    if len(body) < 1 + HEADER_BYTES:
        raise ValueError("W/F frame too short")
    x_bin, flags_zoom, _seq = struct.unpack_from("<III", body, 1)
    zoom = flags_zoom & 0xFFFF
    if zoom > MAX_ZOOM:
        raise ValueError(f"W/F zoom {zoom} out of range")
    bins = np.frombuffer(body[1 + HEADER_BYTES :], dtype=np.uint8)
    # Real Kiwis always send WF_BINS. More would let a hostile receiver hand
    # the peak finder a huge frame on the loop that streams everyone's audio.
    if bins.size != WF_BINS:
        raise ValueError(f"W/F frame has {bins.size} bins, expected {WF_BINS}")
    return WaterfallFrame(
        zoom=zoom,
        start_khz=x_bin * bandwidth_khz / (WF_BINS * 2**MAX_ZOOM),
        span_khz=bandwidth_khz / 2**zoom,
        bins=bins,
    )


class WaterfallClient(KiwiConnection):
    """A W/F stream, paired with a KiwiClient by passing its timestamp.

    Usage:
        wf = WaterfallClient(host, port, connect_host=ip, timestamp=client.timestamp)
        await wf.connect()
        frame = await wf.frame(zoom=6, cf_khz=9650.0)
        await wf.idle()  # until the listener stops; then close()
    """

    STREAM = "W/F"
    HANDSHAKE_WANTS = "its waterfall setup"
    # Paired with the audio, so closing it would end the listener's audio; the
    # session keeps it drained (idle) and closes it when the audio ends.
    CLOSE_ON_HANDSHAKE_TIMEOUT = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.bandwidth_khz = 30_000.0
        self._setup = False
        self._configured = False

    @property
    def is_open(self) -> bool:
        """Still connected: closing it now would end the paired audio."""
        return self._ws is not None and self._ws.state is State.OPEN

    async def _handshake(self) -> None:
        while not self._setup:
            frame = await self._recv()
            self._answered = True
            if frame[:3] == b"MSG":
                self._handle_msg(parse_msg(frame[4:]))
        await self._configure()

    async def _configure(self) -> None:
        await self._send("SET maxdb=0 mindb=-200")  # needed, though uncompressed bins ignore it
        await self._send("SET wf_comp=0")
        await self._send(f"SET wf_speed={FAST_SPEED}")
        await self._send(f"SET ident_user={self.user}")
        await self._keepalive(force=True)
        self._configured = True

    def _handle_msg(self, params: dict[str, str | None]) -> None:
        for name, value in params.items():
            self._check_refusal(name, value)
            if name == "freq_offset" and value:
                offset = _number(value)
                if offset is not None:
                    self.info.freq_offset_khz = offset
            elif name == "bandwidth" and value:
                bandwidth = _number(value)
                # A Kiwi samples at most about 32 MHz; anything else is junk.
                if bandwidth is not None and MIN_BANDWIDTH_KHZ <= bandwidth / 1000 <= MAX_BANDWIDTH_KHZ:
                    self.bandwidth_khz = bandwidth / 1000
            elif name == "wf_setup":
                self._setup = True
            elif len(self.info.extra) < MAX_EXTRA_KEYS:
                self.info.extra[name] = value

    async def frame(self, zoom: int, cf_khz: float) -> WaterfallFrame:
        """The first settled frame at this zoom and centre (baseband kHz).

        Frames still showing the previous position are skipped, and so is the
        first matching one, which can straddle the change.
        """
        if not 0 <= zoom <= MAX_ZOOM:
            raise ValueError(f"zoom {zoom} out of range")
        span = self.bandwidth_khz / 2**zoom
        start = cf_khz - span / 2
        await self._send(f"SET zoom={zoom} cf={cf_khz:.3f}")
        matched = 0
        while True:
            async with asyncio.timeout(self.timeout_s):
                data = await self._next()
            if data[:3] != b"W/F":
                continue
            wf = parse_wf(data[3:], self.bandwidth_khz)
            if wf.zoom != zoom or abs(wf.start_khz - start) > span * START_TOLERANCE:
                continue
            matched += 1
            if matched >= 2:
                return wf

    async def fast(self) -> None:
        """Back to sweep speed after idle().

        A waterfall whose handshake timed out may have sent its setup since,
        while idling; it gets the settings then. One that still hasn't can't
        sweep, and raises KiwiError (it stays open: closing ends the audio).
        """
        if not self._configured:
            if not self._setup:
                raise KiwiError("timeout", f"{self.host} never sent {self.HANDSHAKE_WANTS}")
            await self._configure()
            return
        await self._send(f"SET wf_speed={FAST_SPEED}")

    async def idle(self) -> None:
        """Keep the stream open and drained at about a frame a second.

        Never returns while the Kiwi keeps it open; raises KiwiError when it
        closes. Run it as a task and cancel it when the listener stops.
        """
        await self._send(f"SET wf_speed={IDLE_SPEED}")
        while True:
            # Keepalives go out even if frames stop: a W/F the Kiwi drops for
            # silence takes the paired audio with it.
            try:
                async with asyncio.timeout(KEEPALIVE_S):
                    await self._next()
            except TimeoutError:
                continue

    async def _next(self) -> bytes:
        """The next frame, with keepalives sent and MSG refusals raised."""
        await self._keepalive()
        data = await self._recv()
        if data[:3] == b"MSG":
            self._handle_msg(parse_msg(data[4:]))
        return data


def _number(value: str) -> float | None:
    """A finite number from a MSG value, or None: a hostile Kiwi can send anything."""
    try:
        number = float(value)
    except ValueError:
        return None
    return number if math.isfinite(number) else None
