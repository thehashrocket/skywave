"""Label ham signals automatically from record_ham.py --reference captures.

    python scripts/auto_label.py spike/kiwi1 [--force]

A stand-in for labeling by ear (plan R7): each reference capture is a few
seconds of every waterfall frame at a finer zoom (REF_ZOOM, about 57 Hz a bin
on a 30 MHz Kiwi, against the detector's 229) over a whole band. The detector
sees one frame or half a second of max-hold; the labeler sees each bin over
time, so it can tell a keyed CW signal from a carrier and speech from a steady
wideband mode. None of scan.py's thresholds or code is used.

It writes <dir>/labels.json in eval_ham.py's format: a label per signal and a
"complete" entry per band the round referenced (every signal of the listed
kinds the labeler found there). It won't overwrite a labels.json it didn't
write (one with your own labels) unless --force.

These labels are the labeler's opinion, not ground truth: check a sample by
ear (clips/ in each directory) before trusting a score against them.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from skywave_radio.scan import DIGITAL_WIDTH_KHZ, DIGITAL_WINDOWS, HAM_SEGMENTS  # noqa: E402

REF_ZOOM = 9
REF_S = 3.0  # seconds of frames per reference position
LEVEL_DB = 8.0  # a bin is "on" in a frame this far above that frame's median
PRESENT_DB = 10.0  # a signal's bins reach this at their 90th percentile over time
GAP_BINS = 3  # gaps this short inside one signal are bridged
EDGE_BINS = 2  # runs touching the frame's edge are left to the overlapping frame
CW_MAX_KHZ = 0.3
# Keyed CW swings from its full level down to the noise; a carrier, a WSPR or
# PSK tone, or a weak carrier flickering around LEVEL_DB doesn't.
KEYED_DEPTH_DB = 10.0  # 90th minus 10th percentile of the signal's level over time
KEYED_ON = (0.1, 0.9)  # share of frames it is on
# A narrow 57 Hz bin flatters CW: through a 500 Hz CW filter it is about 10 dB
# weaker. In the 2026-10-28 ear check every CW label under this was inaudible
# (4 of 4) and the 32 dB one was clear.
CW_AUDIBLE_DB = 20.0
VOICE_KHZ = (1.5, 3.4)  # an SSB voice's width, at the 90th percentile
VOICE_SPLIT_KHZ = 7.0  # wider runs aren't split into two voices
VOICE_STD_DB = 2.0  # speech rises and falls; a steady wide signal is a digital mode
AM_CARRIER_DB = 10.0
SSB_EDGE_KHZ = 0.3
DIGITAL_MIN_BINS = 3  # about two FT8 signals' worth of bins on most of the time
MERGE_KHZ = {"voice": 0.5, "cw": 0.1, "digital": 0.0}
WROTE_BY = "auto_label.py"


def _runs(mask: np.ndarray, gap: int) -> list[tuple[int, int]]:
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return []
    breaks = np.flatnonzero(np.diff(idx) > gap + 1)
    starts = np.concatenate(([0], breaks + 1))
    ends = np.concatenate((breaks, [idx.size - 1]))
    return [(int(idx[s]), int(idx[e])) for s, e in zip(starts, ends)]


def label_frames(stack: np.ndarray, start_khz: float, span_khz: float, seg: tuple[str, str, float, float]) -> list[dict]:
    """Signals in one reference position: stack is (frames, bins), start_khz RF.

    seg is (band, kind, lo, hi): the segment this position covers. Labels only
    what the detector is meant to list there: digital in the FT8/FT4 windows,
    CW in a CW segment, SSB voice in a phone segment.
    """
    band, kind, lo, hi = seg
    n = stack.shape[1]
    kb = span_khz / n
    level = stack.astype(np.float32) - np.median(stack, axis=1, keepdims=True)
    p90 = np.percentile(level, 90, axis=0)
    freqs = start_khz + (np.arange(n) + 0.5) * kb
    out: list[dict] = []
    taken = np.zeros(n, dtype=bool)

    for _name, dial in DIGITAL_WINDOWS:
        inside = (freqs >= dial) & (freqs <= dial + DIGITAL_WIDTH_KHZ)
        taken |= inside  # never CW or voice, as in the detector, even when cut off here
        if not (lo <= dial < hi and start_khz <= dial and dial + DIGITAL_WIDTH_KHZ <= start_khz + span_khz):
            continue  # judged by the position that holds the whole window
        busy = int((np.median(level[:, inside], axis=0) >= LEVEL_DB - 2).sum())
        if busy >= DIGITAL_MIN_BINS:
            out.append({"kind": "digital", "freqKhz": dial, "mode": "usb", "band": band, "snrDb": round(float(p90[inside].max()))})

    def classify(a: int, b: int) -> None:
        width = (b - a + 1) * kb
        centre = float(freqs[a : b + 1].mean())
        if a < EDGE_BINS or b >= n - EDGE_BINS or not lo <= centre <= hi or taken[a : b + 1].any():
            return
        snr = round(float(p90[a : b + 1].max()))
        if kind == "cw":
            if width > CW_MAX_KHZ:
                return  # RTTY, PSK and friends: not something the CW list should show
            if snr < CW_AUDIBLE_DB:
                return  # there, but too weak for a listener to hear
            series = level[:, a : b + 1].max(axis=1)
            depth = float(np.percentile(series, 90) - np.percentile(series, 10))
            if depth < KEYED_DEPTH_DB or not KEYED_ON[0] <= float((series >= LEVEL_DB).mean()) <= KEYED_ON[1]:
                return  # not keyed while we watched: a carrier, a narrow digital mode
            weight = 10 ** (p90[a : b + 1] / 10)
            freq = float((freqs[a : b + 1] * weight).sum() / weight.sum())
            out.append({"kind": "cw", "freqKhz": round(freq, 2), "mode": "cw", "band": band, "snrDb": snr})
        elif kind == "phone":
            if VOICE_KHZ[1] < width <= VOICE_SPLIT_KHZ:
                # Two voices side by side: split at the quietest point between them.
                margin = int(VOICE_KHZ[0] / kb)
                if b - a > 2 * margin:
                    cut = a + margin + int(np.argmin(p90[a + margin : b - margin + 1]))
                    for x, y in _runs(p90[a : b + 1] >= PRESENT_DB, GAP_BINS):
                        x, y = a + x, a + y
                        if y < cut:
                            classify(x, min(y, cut - 1))
                        elif x > cut:
                            classify(max(x, cut + 1), y)
                return
            if not VOICE_KHZ[0] <= width <= VOICE_KHZ[1]:
                return
            run = p90[a : b + 1]
            if run.max() - np.median(run) >= AM_CARRIER_DB:
                return  # an AM carrier: a broadcaster, not a ham voice
            if level[:, a : b + 1].mean(axis=1).std() < VOICE_STD_DB:
                return  # steady across the frames: a wide digital mode or noise
            lo_edge, hi_edge = float(freqs[a] - kb / 2), float(freqs[b] + kb / 2)
            if centre < 10_000:
                out.append({"kind": "voice", "freqKhz": round(hi_edge + SSB_EDGE_KHZ, 2), "mode": "lsb", "band": band, "snrDb": snr})
            else:
                out.append({"kind": "voice", "freqKhz": round(lo_edge - SSB_EDGE_KHZ, 2), "mode": "usb", "band": band, "snrDb": snr})

    for a, b in _runs(p90 >= PRESENT_DB, GAP_BINS):
        classify(a, b)
    return out


def merge(labels: list[dict]) -> list[dict]:
    """One label per signal seen by overlapping positions: the strongest."""
    kept: list[dict] = []
    for lab in sorted(labels, key=lambda x: -x["snrDb"]):
        if any(k["kind"] == lab["kind"] and abs(k["freqKhz"] - lab["freqKhz"]) <= MERGE_KHZ[lab["kind"]] for k in kept):
            continue
        kept.append(lab)
    return sorted(kept, key=lambda x: x["freqKhz"])


def band_kinds(band: str) -> list[str]:
    """What a fully referenced band vouches for."""
    kinds = []
    if any(s.name == band and s.kind == "phone" for s in HAM_SEGMENTS):
        kinds.append("voice")
    if any(s.name == band and s.kind == "cw" for s in HAM_SEGMENTS):
        kinds.append("cw")
    segs = [s for s in HAM_SEGMENTS if s.name == band]
    if any(any(s.start_khz <= dial < s.end_khz for s in segs) for _n, dial in DIGITAL_WINDOWS):
        kinds.append("digital")
    return kinds


def label_reference(path: Path) -> list[dict]:
    """Labels and "complete" entries from one reference-NN.npz."""
    data = np.load(path)
    utc = str(data["round_utc"])
    found = []
    bands: set[str] = set()
    for i, seg in enumerate(data["segment"]):
        name, kind, lo, hi, _cf = str(seg).split("|")
        bands.add(name)
        stack = data[f"frames_{i:02d}"]
        found += label_frames(stack, float(data["start_khz"][i]), float(data["span_khz"][i]), (name, kind, float(lo), float(hi)))
    out = [{"utc": utc, **lab} for lab in merge(found)]
    out += [{"utc": utc, "kind": "complete", "band": b, "kinds": band_kinds(b)} for b in sorted(bands)]
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", type=Path, nargs="+")
    ap.add_argument("--force", action="store_true", help="overwrite a labels.json this script didn't write")
    args = ap.parse_args()
    for folder in args.dirs:
        target = folder / "labels.json"
        if target.exists() and not args.force and not (folder / ".labels-auto").exists():
            sys.exit(f"{target} has labels this script didn't write; pass --force to replace them")
        labels = [lab for path in sorted(folder.glob("reference-*.npz")) for lab in label_reference(path)]
        target.write_text(json.dumps(labels, indent=1))
        (folder / ".labels-auto").write_text(WROTE_BY)
        counts = {k: sum(1 for x in labels if x["kind"] == k) for k in ("voice", "cw", "digital", "complete")}
        print(f"{folder}: {counts}")


if __name__ == "__main__":
    main()
