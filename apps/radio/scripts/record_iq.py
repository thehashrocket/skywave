"""Record raw I/Q from a public KiwiSDR to a stereo WAV (left = I, right = Q).

    python scripts/record_iq.py --host <kiwi host> --freq 9535 --seconds 30 --out wwv.wav

The WAV header stores the sample rate rounded to an integer; the exact rate
the Kiwi reported is written alongside as <out>.json.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from skywave_radio.hostguard import resolve_receiver  # noqa: E402
from skywave_radio.kiwi import DEFAULT_PORT, KiwiClient  # noqa: E402


async def record(host: str, port: int, freq: float, seconds: float, out: Path, kiwi_agc: bool) -> None:
    ip = await resolve_receiver(host, port, allow_private=True)
    client = KiwiClient(host, port, connect_host=ip, kiwi_agc=kiwi_agc)
    await client.tune(freq)
    info = await client.connect()
    rate = info.sample_rate or 12000.0
    target = int(rate * seconds)
    chunks: list[np.ndarray] = []
    got = 0
    print(f"Connected to {host}, sample rate {rate:.3f} Hz. Recording {seconds:g}s at {freq} kHz...")
    try:
        async for block in client.blocks():
            chunks.append(block.samples)
            got += block.samples.size
            print(f"\r  {got / rate:5.1f}s  RSSI {block.rssi_dbm:6.1f} dBm", end="", flush=True)
            if got >= target:
                break
    finally:
        await client.close()
    print()

    iq = np.concatenate(chunks)[:target]
    interleaved = np.empty(iq.size * 2, dtype="<i2")
    interleaved[0::2] = np.clip(iq.real * 32768, -32768, 32767)
    interleaved[1::2] = np.clip(iq.imag * 32768, -32768, 32767)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(int(round(rate)))
        w.writeframes(interleaved.tobytes())
    out.with_suffix(out.suffix + ".json").write_text(
        json.dumps({"host": host, "port": port, "freqKhz": freq, "sampleRate": rate, "samples": int(iq.size)}, indent=2)
    )
    print(f"Wrote {out} ({iq.size / rate:.1f}s of I/Q)")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", required=True)
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--freq", type=float, required=True, help="kHz")
    p.add_argument("--seconds", type=float, default=30)
    p.add_argument("--out", type=Path, default=Path("capture.wav"))
    p.add_argument("--no-kiwi-agc", action="store_true", help="raw levels; do all gain control yourself")
    a = p.parse_args()
    asyncio.run(record(a.host, a.port, a.freq, a.seconds, a.out, not a.no_kiwi_agc))


if __name__ == "__main__":
    main()
