"""A tiny fake KiwiSDR for tests: speaks just enough of the SND protocol."""

from __future__ import annotations

import asyncio
import ssl
import struct
from dataclasses import dataclass, field

import numpy as np
from websockets.asyncio.server import ServerConnection, serve
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
    # Handshake normally, then never send audio.
    stall: bool = False
    # Close the connection after this many SND frames.
    drop_after: int | None = None
    # Serve wss:// with this context.
    ssl: ssl.SSLContext | None = None
    # Answer the upgrade with a 301 to this Location instead of a WebSocket.
    redirect_to: str | None = None
    commands: list[str] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)
    port: int = 0

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
        first = await ws.recv()
        self.commands.append(first)
        if self.reject is not None:
            await ws.send(self.reject)
            await asyncio.sleep(0.2)
            return
        await asyncio.sleep(self.handshake_delay)
        await ws.send(b"MSG version_maj=1 version_min=799")
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
            seq, n = 0, 0
            while self.drop_after is None or seq < self.drop_after:
                t = (np.arange(BLOCK) + n) / RATE
                iq = 0.2 * np.exp(2j * np.pi * self.tone_hz * t)
                inter = np.empty(BLOCK * 2, dtype=">i2")
                inter[0::2] = (iq.real * 32767).astype(np.int16)
                inter[1::2] = (iq.imag * 32767).astype(np.int16)
                smeter = int((-73.0 + 127) * 10)
                frame = b"SND" + struct.pack("<BI", 0x08, seq) + struct.pack(">H", smeter) + bytes(10) + inter.tobytes()
                await ws.send(frame)
                seq += 1
                n += BLOCK
                await asyncio.sleep(BLOCK / RATE / 4)  # faster than real time
        except Exception:
            pass
        finally:
            rtask.cancel()
