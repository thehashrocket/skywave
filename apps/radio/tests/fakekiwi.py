"""A tiny fake KiwiSDR for tests: speaks just enough of the SND and W/F protocols."""

from __future__ import annotations

import asyncio
import ssl
import struct
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np
from websockets.asyncio.server import ServerConnection, serve
from websockets.protocol import State
from websockets.http11 import Request, Response

RATE = 12000.0
BLOCK = 512


@dataclass
class FakeKiwi:
    # A MSG frame to send instead of the handshake, e.g. b"MSG too_busy=4".
    reject: bytes | None = None
    tone_hz: float = 1000.0
    # What the fake reports as its I/Q rate (it always streams at RATE).
    sample_rate: str = "12000.000"
    # Seconds to wait before starting the handshake.
    handshake_delay: float = 0.0
    # Accept the WebSocket, then never send a frame.
    silent: bool = False
    # Send the version but never the sample rate.
    no_rate: bool = False
    # Handshake normally, then never send audio.
    stall: bool = False
    # Send this many SND frames with no samples before the tone.
    empty_blocks: int = 0
    # Also make every Nth SND frame empty, counting from the first (empty_blocks included).
    empty_every: int | None = None
    # Samples per SND frame of tone. Frames keep BLOCK's pace, so a small
    # block_size is a receiver trickling audio.
    block_size: int = BLOCK
    # Handshake normally, then send only MSG frames, never audio.
    msg_only: bool = False
    # Send only empty SND frames after this many, as if the tone stopped.
    empty_after: int | None = None
    # Close the connection after this many SND frames.
    drop_after: int | None = None
    # With drop_after, send this MSG frame just before closing, e.g. b"MSG too_busy=0".
    last_words: bytes | None = None
    # Serve wss:// with this context.
    ssl: ssl.SSLContext | None = None
    # Answer the upgrade with a 301 to this Location instead of a WebSocket.
    redirect_to: str | None = None
    # W/F: what the receiver reports, and the bins for a frame given its
    # baseband start and span in kHz (default: flat noise at 140).
    freq_offset_khz: float = 0.0
    bandwidth_khz: float = 30_000.0
    wf_bins: Callable[[float, float], np.ndarray] | None = None
    # W/F frames still showing the previous position after each SET zoom.
    wf_stale_frames: int = 2
    # Seconds between W/F frames (a real Kiwi: about 0.04 fast, 1 idle).
    wf_interval: float = 0.005
    # Close a W/F connection after this many frames.
    wf_drop_after: int | None = None
    # A MSG frame to answer a W/F connection with instead of its setup.
    wf_reject: bytes | None = None
    # Answer a W/F connection but never send wf_setup.
    wf_no_setup: bool = False
    # W/F connections opened (paths) and closed so far.
    wf_closed: int = 0
    # Like a real Kiwi: refuse a W/F whose timestamp differs from an open SND's
    # (badp=5), and end the SND when its paired W/F closes.
    pairing: bool = True
    commands: list[str] = field(default_factory=list)
    wf_commands: list[str] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)
    port: int = 0
    _snd: dict[str, ServerConnection] = field(default_factory=dict)

    async def __aenter__(self) -> "FakeKiwi":
        self._server = await serve(self._handle, "127.0.0.1", 0, ssl=self.ssl, process_request=self._redirect)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    def _redirect(self, conn: ServerConnection, request: Request) -> Response | None:
        self.paths.append(request.path)
        if self.redirect_to is None:
            return None
        response = conn.respond(301, "Moved\n")
        response.headers["Location"] = self.redirect_to
        return response

    async def __aexit__(self, *exc) -> None:
        self._server.close()
        await self._server.wait_closed()

    async def _handle(self, ws: ServerConnection) -> None:
        path = ws.request.path if ws.request else ""
        if path.endswith("/W/F"):
            await self._handle_wf(ws, path.split("/")[-3])
            return
        self._snd[path.split("/")[-2]] = ws
        first = await ws.recv()
        self.commands.append(first)
        if self.reject is not None:
            await ws.send(self.reject)
            await asyncio.sleep(0.2)
            return
        if self.silent:
            await ws.wait_closed()
            return
        await asyncio.sleep(self.handshake_delay)
        await ws.send(b"MSG version_maj=1 version_min=799")
        if self.no_rate:
            await ws.wait_closed()
            return
        await ws.send(b"MSG audio_rate=12000")
        await ws.send(f"MSG sample_rate={self.sample_rate}".encode())

        streaming = asyncio.Event()

        async def reader() -> None:
            async for msg in ws:
                self.commands.append(msg)
                if isinstance(msg, str) and msg.startswith("SET mod=iq"):
                    streaming.set()

        rtask = asyncio.create_task(reader())
        try:
            await asyncio.wait_for(streaming.wait(), 5)
            if self.stall:
                await ws.wait_closed()
                return
            if self.msg_only:
                while True:
                    await ws.send(b"MSG status=ok")
                    await asyncio.sleep(0.01)
            seq, n = 0, 0
            while self.drop_after is None or seq < self.drop_after:
                empty = (
                    seq < self.empty_blocks
                    or (self.empty_every is not None and seq % self.empty_every == 0)
                    or (self.empty_after is not None and seq >= self.empty_after)
                )
                size = 0 if empty else self.block_size
                t = (np.arange(size) + n) / RATE
                iq = 0.2 * np.exp(2j * np.pi * self.tone_hz * t)
                inter = np.empty(size * 2, dtype=">i2")
                inter[0::2] = (iq.real * 32767).astype(np.int16)
                inter[1::2] = (iq.imag * 32767).astype(np.int16)
                smeter = int((-73.0 + 127) * 10)
                frame = b"SND" + struct.pack("<BI", 0x08, seq) + struct.pack(">H", smeter) + bytes(10) + inter.tobytes()
                await ws.send(frame)
                seq += 1
                n += size
                await asyncio.sleep(BLOCK / RATE / 4)  # faster than real time
            if self.last_words is not None:
                await ws.send(self.last_words)
                await asyncio.sleep(0.2)
        except Exception:
            pass
        finally:
            rtask.cancel()

    def _open_snd(self) -> dict[str, ServerConnection]:
        return {ts: ws for ts, ws in self._snd.items() if ws.state is State.OPEN}

    async def _handle_wf(self, ws: ServerConnection, ts: str) -> None:
        # Counted once on every path, including a client that goes away
        # mid-handshake (a send then raises before any other bookkeeping).
        try:
            await self._serve_wf(ws, ts)
        finally:
            self.wf_closed += 1

    async def _serve_wf(self, ws: ServerConnection, ts: str) -> None:
        first = await ws.recv()
        self.wf_commands.append(first)
        reject = self.wf_reject or self.reject
        if reject is not None:
            await ws.send(reject)
            await asyncio.sleep(0.2)
            return
        others = self._open_snd()
        if self.pairing and others and ts not in others:
            await ws.send(b"MSG badp=5")
            await asyncio.sleep(0.2)
            return
        await ws.send(f"MSG freq_offset={self.freq_offset_khz:.3f} bandwidth={self.bandwidth_khz * 1000:.0f}".encode())
        if self.wf_no_setup:
            async for msg in ws:
                self.wf_commands.append(msg)
            return
        await ws.send(b"MSG wf_setup")

        position = [0, 0.0]  # zoom, baseband start in kHz
        stale = [0]

        async def reader() -> None:
            async for msg in ws:
                self.wf_commands.append(msg)
                if isinstance(msg, str) and msg.startswith("SET zoom="):
                    parts = dict(p.split("=", 1) for p in msg[4:].split(" "))
                    zoom = int(parts["zoom"])
                    span = self.bandwidth_khz / 2**zoom
                    stale[0] = self.wf_stale_frames
                    position[:] = [zoom, float(parts["cf"]) - span / 2]

        rtask = asyncio.create_task(reader())
        sent = 0
        old = [0, 0.0]
        try:
            while self.wf_drop_after is None or sent < self.wf_drop_after:
                zoom, start = old if stale[0] > 0 else position
                if stale[0] > 0:
                    stale[0] -= 1
                else:
                    old = list(position)
                span = self.bandwidth_khz / 2**zoom
                bins = self.wf_bins(start, span) if self.wf_bins else np.full(1024, 140, dtype=np.uint8)
                x_bin = round(start / self.bandwidth_khz * 1024 * 2**14)
                header = struct.pack("<III", max(0, x_bin), zoom, sent)
                await ws.send(b"W/F" + b"\x00" + header + np.asarray(bins, dtype=np.uint8).tobytes())
                sent += 1
                await asyncio.sleep(self.wf_interval)
        except Exception:
            pass
        finally:
            rtask.cancel()
            await ws.close()
            if self.pairing and ts in self._open_snd():
                # A real Kiwi ends the paired audio with its waterfall.
                await self._snd[ts].close()
