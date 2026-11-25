"""Record I/Q from up to three public KiwiSDRs at once, for a scheduled window.

    python scripts/record_window.py --freq 7107 --start 2026-11-27T01:00:00Z --minutes 10 \\
        --out-dir ../../.local-data/ghostnet/2026-11-27-na \\
        23175.proxy.kiwisdr.com 22201.proxy.kiwisdr.com mtkiwi.proxy.kiwisdr.com

Waits until --start (UTC), then holds one channel on each receiver until the
window ends. A receiver that drops (a time limit, a busy Kiwi, a network blip)
is dialed again after a pause, into a new file, until the window is over.

Each segment is a stereo WAV (left = I, right = Q) at the Kiwi's I/Q rate,
written as it arrives, so a crash keeps what was recorded. The Kiwi streams
±5 kHz around --freq, which covers the whole USB audio passband (JS8 sits at
about 500-2500 Hz above the dial). The exact sample rate, receiver and start
time go in a .json sidecar beside each file, which iqwav.read_iq_wav reads.

Hosts are host, host:port, or an http(s):// URL from the public list.
Recordings are large (about 2.9 MB a minute per receiver): keep them out of git.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from skywave_radio.hostguard import resolve_receiver  # noqa: E402
from skywave_radio.kiwi import DEFAULT_PORT, KiwiClient, KiwiError  # noqa: E402

# Each one holds a channel on a volunteer's receiver.
MAX_RECEIVERS = 3
RETRY_S = 20.0
# KiwiError codes that mean the owner refuses this kind of connection; never retried.
REFUSALS = frozenset({"no_apps", "password", "blocked"})


def parse_host(raw: str) -> tuple[str, int, bool]:
    """host, port and whether to dial wss:// from host, host:port or a URL."""
    url = urlsplit(raw if "://" in raw else f"//{raw}")
    secure = url.scheme == "https"
    if not url.hostname:
        raise SystemExit(f"can't read a host from {raw!r}")
    return url.hostname, url.port or (443 if secure else DEFAULT_PORT), secure


def parse_utc(raw: str) -> float:
    dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise SystemExit("--start needs a time zone, e.g. 2026-11-27T01:00:00Z")
    return dt.timestamp()


def stamp(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def log(name: str, msg: str) -> None:
    print(f"{datetime.now(timezone.utc):%H:%M:%S} {name}: {msg}", flush=True)


async def record_segment(host: str, port: int, secure: bool, freq: float, end: float, out_dir: Path) -> float:
    """One connection, recorded until `end` or until it drops. Returns seconds recorded."""
    ip = await resolve_receiver(host, port, allow_private=False)
    client = KiwiClient(host, port, connect_host=ip, secure=secure)
    await client.tune(freq)
    info = await client.connect()
    rate = info.sample_rate or 12000.0
    started = time.time()
    path = out_dir / f"{host}_{port}_{freq:g}kHz_{stamp(started)}.wav"
    meta = {
        "host": host,
        "port": port,
        "freqKhz": freq,
        "mode": "usb",
        "sampleRate": rate,
        "startUtc": datetime.fromtimestamp(started, timezone.utc).isoformat(),
        "samples": 0,
    }
    sidecar = path.with_suffix(path.suffix + ".json")
    sidecar.write_text(json.dumps(meta, indent=2))
    log(host, f"connected, {rate:.3f} Hz, writing {path.name}")
    got = 0
    last_note = started
    w = wave.open(str(path), "wb")
    try:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(int(round(rate)))
        async for block in client.blocks():
            iq = block.samples
            if not iq.size:
                continue
            inter = np.empty(iq.size * 2, dtype="<i2")
            inter[0::2] = np.clip(iq.real * 32768, -32768, 32767)
            inter[1::2] = np.clip(iq.imag * 32768, -32768, 32767)
            w.writeframes(inter.tobytes())
            got += iq.size
            now = time.time()
            if now - last_note >= 60:
                last_note = now
                log(host, f"{got / rate:5.0f}s, RSSI {block.rssi_dbm:6.1f} dBm")
            if now >= end:
                break
    finally:
        w.close()
        meta["samples"] = got
        sidecar.write_text(json.dumps(meta, indent=2))
        await client.close()
    return got / rate


async def record_receiver(raw: str, freq: float, start: float, end: float, out_dir: Path) -> None:
    host, port, secure = parse_host(raw)
    name = f"{host}:{port}"
    total = 0.0
    while time.time() < end - 5:
        try:
            total += await record_segment(host, port, secure, freq, end, out_dir)
        except KiwiError as e:
            log(name, f"dropped: {e}")
            if e.code in REFUSALS:
                # The owner said no (apps not allowed, a password, blocked): don't keep asking.
                log(name, "giving up on this receiver; start another in its place")
                break
        except (OSError, asyncio.TimeoutError) as e:
            log(name, f"dropped: {e}")
        except Exception as e:  # keep the other receivers going whatever happens here
            log(name, f"failed: {e!r}")
        if time.time() < end - RETRY_S:
            log(name, f"trying again in {RETRY_S:g}s")
            await asyncio.sleep(RETRY_S)
        else:
            break
    log(name, f"done, {total:.0f}s recorded of {end - start:.0f}s")


async def main_async(a: argparse.Namespace) -> None:
    start = parse_utc(a.start) if a.start else time.time()
    end = start + a.minutes * 60
    a.out_dir.mkdir(parents=True, exist_ok=True)
    wait = start - time.time()
    if wait > 0:
        log("window", f"waiting {wait / 60:.1f} min until {stamp(start)}")
        await asyncio.sleep(wait)
    log("window", f"recording {a.freq:g} kHz on {len(a.hosts)} receiver(s) until {stamp(end)}")
    await asyncio.gather(*(record_receiver(h, a.freq, start, end, a.out_dir) for h in a.hosts))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("hosts", nargs="+", help=f"up to {MAX_RECEIVERS} receivers")
    p.add_argument("--freq", type=float, required=True, help="dial frequency, kHz")
    p.add_argument("--start", help="UTC start, e.g. 2026-11-27T01:00:00Z (default: now)")
    p.add_argument("--minutes", type=float, default=10)
    p.add_argument("--out-dir", type=Path, required=True)
    a = p.parse_args()
    if len(a.hosts) > MAX_RECEIVERS:
        p.error(f"at most {MAX_RECEIVERS} receivers: each one holds a volunteer's channel")
    asyncio.run(main_async(a))


if __name__ == "__main__":
    main()
