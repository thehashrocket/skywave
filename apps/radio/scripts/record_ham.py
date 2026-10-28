"""Ham scan spike: time real sweeps and record the amateur frames for labeling.

    python scripts/record_ham.py --host <kiwi host> --out spike/kiwi1 --rounds 10 --every 60

Each round runs the same two passes the service runs (broadcast, then the
amateur segments with phone frames held for HOLD_S) on a paired SND + W/F,
like a listener's scan, and writes:

  <out>/round-NN.npz   every amateur frame (bins, start, span, zoom, segment)
  <out>/timing.json    seconds per pass and per frame, per round

While it runs, listen to the same receiver in skywave (or any Kiwi page) and
write <out>/labels.json, one entry per signal you identified by ear:

  [{"utc": "2026-11-01T14:03:20Z", "kind": "voice", "freqKhz": 14251.3, "mode": "usb"},
   {"utc": "2026-11-01T14:05:02Z", "kind": "cw", "freqKhz": 14025.4},
   {"utc": "2026-11-01T14:06:40Z", "kind": "digital", "freqKhz": 14074}]

freqKhz is the dial you tuned it on (for CW, the signal). Note the UTC time
of each label: a label only counts toward the round that started closest to
it, within 90 seconds. When you've labeled everything real you can hear on a
band, add {"utc": ..., "kind": "complete", "band": "20m"}: only bands marked
complete count rows nobody labeled as false; elsewhere they're listed for you
to check by ear. Then score the detector with scripts/eval_ham.py (see the
plan's R6/R7 for the pass bar).

With --reference, each round is followed by a reference pass for
scripts/auto_label.py, a stand-in for labeling by ear: two bands per round
(rotating, so ten rounds cover each band twice) at a finer zoom, every frame
kept for REF_S seconds at each position, written to reference-NN.npz. Then a
few audio clips (clips/, listed in clips.json) of rows where the detector and
the labeler disagree, or agree, to check the labeler by ear; and 15 s of I/Q
from one FT8 slot (ft8/), to decode later. Leave --every at 150 or more.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import sys
import math
import random
import time
from collections.abc import AsyncIterator
from contextlib import aclosing, asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from skywave_radio.hostguard import resolve_receiver  # noqa: E402
from skywave_radio.kiwi import DEFAULT_PORT, KiwiClient  # noqa: E402
from auto_label import REF_S, REF_ZOOM, label_frames, merge  # noqa: E402
from iqwav import write_audio_wav  # noqa: E402
from skywave_radio.dsp import Demodulator  # noqa: E402
from skywave_radio.scan import (  # noqa: E402
    DEADLINE_S,
    DIGITAL_WINDOWS,
    HAM_SEGMENTS,
    HOLD_S,
    find_ham,
    plan_frames,
    summarize_ham,
    sweep,
)
from skywave_radio.session import kiwi_freq_khz  # noqa: E402
from skywave_radio.waterfall import WaterfallClient  # noqa: E402

REF_BANDS = tuple(dict.fromkeys(s.name for s in HAM_SEGMENTS))
REF_BANDS_PER_ROUND = 2
REF_OVERLAP_KHZ = 4.0  # reference positions overlap this much, so no signal sits only on an edge
CLIPS_PER_ROUND = 3
# Extra voice clips per round: their I/Q is kept, so the true dial can be found
# by ear (re-tuned offline) or from the speech's pitch harmonics, not from the
# edge-plus-SSB_EDGE_KHZ rule both the detector and the labeler use.
VOICE_DIAL_CLIPS = 2
CLIP_S = 5.0
VOICE_CLIP_S = 8.0
FT8_SLOT_S = 15.0


async def one_round(snd: KiwiClient, wf: WaterfallClient, out: Path, n: int) -> tuple[dict, dict[str, list[dict]]]:
    offset, bandwidth = wf.info.freq_offset_khz, wf.bandwidth_khz
    t0 = time.monotonic()
    broadcast = await sweep(wf.frame, offset, bandwidth, deadline_s=60.0)
    broadcast_s = time.monotonic() - t0

    frames, segs, per_frame, found = [], [], [], []
    t1 = time.monotonic()
    for plan in plan_frames(offset, bandwidth, HAM_SEGMENTS):
        f0 = time.monotonic()
        if plan.band.kind == "phone":
            frame = await wf.hold(plan.band.zoom, plan.cf_khz, HOLD_S)
        else:
            frame = await wf.frame(plan.band.zoom, plan.cf_khz)
        per_frame.append({"segment": f"{plan.band.name} {plan.band.kind}", "s": round(time.monotonic() - f0, 3)})
        frames.append(frame)
        found += find_ham(frame, plan, offset)
        # The plan's edges, clipped to this receiver's coverage, as the service sees them.
        segs.append((plan.band.name, plan.band.kind, plan.lo_khz, plan.hi_khz, plan.cf_khz))
    ham_s = time.monotonic() - t1

    np.savez_compressed(
        out / f"round-{n:02d}.npz",
        utc=datetime.now(UTC).isoformat(timespec="seconds"),
        offset_khz=offset,
        bins=np.stack([f.bins for f in frames]),
        start_khz=np.array([f.start_khz for f in frames]),
        span_khz=np.array([f.span_khz for f in frames]),
        zoom=np.array([f.zoom for f in frames]),
        segment=np.array([f"{s[0]}|{s[1]}|{s[2]}|{s[3]}|{s[4]}" for s in segs]),
    )
    total = broadcast_s + ham_s
    print(
        f"round {n}: broadcast {broadcast_s:.1f}s ({broadcast.bands_done}/{broadcast.bands_total} bands), "
        f"amateur {ham_s:.1f}s, total {total:.1f}s {'OVER' if total > DEADLINE_S else 'within'} the {DEADLINE_S:g}s cap"
    )
    ham = summarize_ham(found, 1, 1)
    timing = {
        "round": n,
        "broadcastS": round(broadcast_s, 2),
        "hamS": round(ham_s, 2),
        "totalS": round(total, 2),
        "frames": per_frame,
    }
    return timing, {k: getattr(ham, k) for k in ("voice", "cw", "digital")}


class AudioTap:
    """Reads the paired SND (the Kiwi drops a channel nobody reads) and hands out clips."""

    def __init__(self, snd: KiwiClient):
        self.snd = snd
        self._want = 0
        self._chunks: list[np.ndarray] = []
        self._got = 0
        self._done: asyncio.Future[np.ndarray] | None = None

    async def run(self) -> None:
        async for block in self.snd.blocks():
            if self._done is None or self._done.done():
                continue
            self._chunks.append(block.samples)
            self._got += block.samples.size
            if self._got >= self._want:
                self._done.set_result(np.concatenate(self._chunks)[: self._want])

    async def capture(self, kiwi_khz: float, seconds: float, settle_s: float = 0.7) -> np.ndarray:
        await self.snd.tune(kiwi_khz)
        await asyncio.sleep(settle_s)  # audio already queued from the old frequency
        assert self.snd.info.sample_rate is not None
        self._chunks, self._got = [], 0
        self._want = int(self.snd.info.sample_rate * seconds)
        self._done = asyncio.get_running_loop().create_future()
        return await asyncio.wait_for(self._done, seconds + 10)


async def series(wf: WaterfallClient, zoom: int, cf_khz: float, seconds: float) -> tuple[np.ndarray, float, float]:
    """Every settled frame at one position for about `seconds`: the labeler wants each, not their max."""
    kept: list[np.ndarray] = []
    end = None
    loop = asyncio.get_running_loop()
    # The private generator hold() uses: the spike tool needs its frames one by one.
    async with aclosing(wf._settled(zoom, cf_khz)) as frames:
        async for f in frames:
            end = end or loop.time() + seconds
            kept.append(f.bins.copy())
            if loop.time() >= end:
                return np.stack(kept), f.start_khz, f.span_khz
    raise AssertionError("unreachable: _settled never ends")


@asynccontextmanager
async def idling(wf: WaterfallClient) -> AsyncIterator[None]:
    """Keep the W/F drained while it isn't sweeping, as the service does, then back to sweep speed."""
    task = asyncio.create_task(wf.idle())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await wf.fast()


def ref_centres(lo: float, hi: float, span: float) -> list[float]:
    """Positions covering lo..hi, each overlapping the next by REF_OVERLAP_KHZ."""
    if hi - lo <= span:
        return [(lo + hi) / 2]
    n = math.ceil((hi - lo - span) / (span - REF_OVERLAP_KHZ)) + 1
    step = (hi - lo - span) / (n - 1)
    return [lo + span / 2 + i * step for i in range(n)]


def pick_clips(labels: list[dict], rows: list[dict], k: int, voices: int = 0) -> list[dict]:
    """Up to k clips, disagreements first: a row the labeler didn't label, a label no row found."""
    near = lambda a, b: a["kind"] == b["kind"] and abs(a["freqKhz"] - b["freqKhz"]) <= 1.0  # noqa: E731
    det_only = [{**r, "source": "detector-only"} for r in rows if not any(near(r, x) for x in labels)]
    lab_only = [{**x, "source": "labeler-only"} for x in labels if not any(near(x, r) for r in rows)]
    both = [{**x, "source": "both"} for x in labels if any(near(x, r) for r in rows)]
    picked: list[dict] = []
    pools = [random.sample(p, len(p)) for p in (det_only, lab_only, both)]
    while len(picked) < k and any(pools):
        for pool in pools:
            if pool and len(picked) < k:
                picked.append(pool.pop())
    spare = [c for pool in pools for c in pool if c["kind"] == "voice"]
    return picked + sorted(spare, key=lambda c: c["source"] != "both")[:voices]


async def reference(
    tap: AudioTap, wf: WaterfallClient, out: Path, n: int, utc: str, rows: dict[str, list[dict]]
) -> dict:
    """The reference pass after round n: fine frames of two bands, clips, one FT8 slot."""
    offset, bandwidth = wf.info.freq_offset_khz, wf.bandwidth_khz
    span = bandwidth / 2**REF_ZOOM
    first = (n - 1) * REF_BANDS_PER_ROUND
    bands = [REF_BANDS[(first + i) % len(REF_BANDS)] for i in range(REF_BANDS_PER_ROUND)]
    t0 = time.monotonic()
    stacks, starts, spans, segs, labels = [], [], [], [], []
    for plan in plan_frames(offset, bandwidth, [s for s in HAM_SEGMENTS if s.name in bands]):
        if any(seg.split("|")[:2] == [plan.band.name, plan.band.kind] for seg in segs):
            continue  # plan_frames repeats a segment per frame; positions come from ref_centres
        for centre in ref_centres(plan.lo_khz, plan.hi_khz, span):
            stack, start, got_span = await series(wf, REF_ZOOM, centre - offset, REF_S)
            seg = (plan.band.name, plan.band.kind, plan.lo_khz, plan.hi_khz)
            stacks.append(stack)
            starts.append(start)
            spans.append(got_span)
            segs.append(f"{seg[0]}|{seg[1]}|{seg[2]}|{seg[3]}|{centre - offset}")
            labels += label_frames(stack, offset + start, got_span, seg)
    np.savez_compressed(
        out / f"reference-{n:02d}.npz",
        round_utc=utc,
        offset_khz=offset,
        start_khz=np.array(starts) + offset,
        span_khz=np.array(spans),
        segment=np.array(segs),
        **{f"frames_{i:02d}": st for i, st in enumerate(stacks)},
    )
    ref_s = time.monotonic() - t0
    labels = merge(labels)

    async with idling(wf):
        clips, ft8_file = await listen(tap, out, n, utc, bands, labels, rows)
    return {"bands": bands, "referenceS": round(ref_s, 2), "clips": clips, "ft8": ft8_file}


async def listen(
    tap: AudioTap, out: Path, n: int, utc: str, bands: list[str], labels: list[dict], rows: dict[str, list[dict]]
) -> tuple[list[dict], str | None]:
    """The audio half of the reference pass: clips to check by ear, then one FT8 slot."""
    clips_dir = out / "clips"
    clips_dir.mkdir(exist_ok=True)
    band_rows = [{**r, "kind": kind} for kind, rs in rows.items() for r in rs if r["band"] in bands]
    clips = []
    rate = tap.snd.info.sample_rate or 12_000.0
    for c in pick_clips(labels, band_rows, CLIPS_PER_ROUND, VOICE_DIAL_CLIPS):
        tuned = kiwi_freq_khz(c["freqKhz"], c["mode"])
        iq = await tap.capture(tuned, VOICE_CLIP_S if c["kind"] == "voice" else CLIP_S)
        demod = Demodulator(rate, c["mode"])
        block = int(rate / 10)
        audio = np.concatenate([demod.process(iq[i : i + block]) for i in range(0, iq.size, block)])
        name = f"{n:02d}-{c['band']}-{c['kind']}-{c['freqKhz']}.wav"
        write_audio_wav(clips_dir / name, audio, rate)
        np.savez_compressed(clips_dir / f"{name[:-4]}.npz", iq=iq, rate=rate, tuned_khz=tuned)
        clips.append({"round": n, "utc": utc, "file": f"clips/{name}", "iq": f"clips/{name[:-4]}.npz", **c})

    # One FT8 slot of the first band that has an FT8 window, aligned to UTC's 15 s grid.
    ft8 = next((dial for name, dial in DIGITAL_WINDOWS if name == "FT8" and _band_of(dial) in bands), None)
    ft8_file = None
    if ft8 is not None:
        await tap.snd.tune(ft8)
        await asyncio.sleep((FT8_SLOT_S - time.time() % FT8_SLOT_S - 0.5) % FT8_SLOT_S)
        slot = datetime.now(UTC).isoformat(timespec="seconds")
        iq = await tap.capture(ft8, FT8_SLOT_S + 1.0, settle_s=0.0)
        (out / "ft8").mkdir(exist_ok=True)
        ft8_file = f"ft8/{n:02d}-{ft8}.npz"
        np.savez_compressed(out / ft8_file, iq=iq, rate=rate, dial_khz=ft8, start_utc=slot)
    return clips, ft8_file


def _band_of(khz: float) -> str | None:
    return next((s.name for s in HAM_SEGMENTS if s.start_khz <= khz < s.end_khz), None)


async def record(host: str, port: int, out: Path, rounds: int, every: float, with_reference: bool) -> None:
    out.mkdir(parents=True, exist_ok=True)
    ip = await resolve_receiver(host, port, allow_private=True)
    # Paired with an SND, as the service does: a W/F alone isn't a listener.
    snd = KiwiClient(host, port, connect_host=ip)
    await snd.tune(14_250.0)
    await snd.connect()
    wf = WaterfallClient(host, port, connect_host=ip, timestamp=snd.timestamp)
    await wf.connect()
    tap = AudioTap(snd)
    drain = asyncio.create_task(tap.run())
    timings, clips = [], []
    try:
        for n in range(1, rounds + 1):
            started = time.monotonic()
            timing, rows = await one_round(snd, wf, out, n)
            if with_reference:
                utc = str(np.load(out / f"round-{n:02d}.npz")["utc"])
                ref = await reference(tap, wf, out, n, utc, rows)
                clips += ref.pop("clips")
                timing["reference"] = ref
                (out / "clips.json").write_text(json.dumps(clips, indent=1))
                print(f"  reference {', '.join(ref['bands'])}: {ref['referenceS']:.0f}s")
            timings.append(timing)
            (out / "timing.json").write_text(json.dumps({"host": host, "port": port, "rounds": timings}, indent=2))
            if n < rounds:
                async with idling(wf):
                    await asyncio.sleep(max(0.0, every - (time.monotonic() - started)))
    finally:
        drain.cancel()
        await wf.close()
        await snd.close()
    totals = sorted(t["totalS"] for t in timings)
    print(f"Total per scan: median {totals[len(totals) // 2]:.1f}s, worst {totals[-1]:.1f}s. Wrote {out}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--rounds", type=int, default=10)
    ap.add_argument("--every", type=float, default=60.0, help="seconds between round starts")
    ap.add_argument("--reference", action="store_true", help="add the reference pass for auto_label.py")
    args = ap.parse_args()
    asyncio.run(record(args.host, args.port, args.out, args.rounds, args.every, args.reference))


if __name__ == "__main__":
    main()
