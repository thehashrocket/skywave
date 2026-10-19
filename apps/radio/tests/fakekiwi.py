"""A tiny fake KiwiSDR for tests: speaks just enough of the SND protocol."""

from __future__ import annotations

import asyncio
import struct
from dataclasses import dataclass, field

import numpy as np
from websockets.asyncio.server import ServerConnection, serve

RATE = 12000.0
BLOCK = 512


@dataclass
class FakeKiwi:
    busy: bool = False
    tone_hz: float = 1000.0
    commands: list[str] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)
    port: int = 0

    async def __aenter__(self) -> "FakeKiwi":
        self._server = await serve(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc) -> None:
        self._server.close()
        await self._server.wait_closed()

    async def _handle(self, ws: ServerConnection) -> None:
        self.paths.append(ws.request.path)
        first = await ws.recv()
        self.commands.append(first)
        if self.busy:
            await ws.send(b"MSG too_busy=4")
            await asyncio.sleep(0.2)
            return
        await ws.send(b"MSG version_maj=1 version_min=799")
        await ws.send(b"MSG audio_rate=12000")
        await ws.send(b"MSG sample_rate=12000.000")

        streaming = asyncio.Event()

        async def reader() -> None:
            async for msg in ws:
                self.commands.append(msg)
                if isinstance(msg, str) and msg.startswith("SET mod=iq"):
                    streaming.set()

        rtask = asyncio.create_task(reader())
        try:
            await asyncio.wait_for(streaming.wait(), 5)
            seq, n = 0, 0
            while True:
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
