"""Find an SSB voice's true dial from its speech, for the voice clips record_ham.py saves.

    python scripts/voice_dial.py spike/kiwi1 spike/kiwi2

Both the detector and auto_label.py put a voice's dial SSB_EDGE_KHZ beyond the
edge of its energy, so scoring one against the other can't catch that rule
being wrong. This doesn't use the edge at all. Voiced speech is a comb of
harmonics at multiples of the speaker's pitch F0; tuned off by delta, every
harmonic moves by delta, so in each frame the comb sits at delta + k * F0.
One frame only gives delta modulo F0, so two cues are combined:

* the stretch: when the pitch glides from F0 to r * F0, harmonic k moves
  from delta + k F0 to delta + k r F0, so the whole spectrum stretches by r
  around delta, the true dial. That pivot is unique; a comb one pitch away
  stretches around the wrong point.
* the comb that fits every voiced frame places delta to a few Hz, but
  equally well one pitch step either way; the stretch, too broad on its own,
  picks which of those it is.

For each voice clip (its I/Q, centred on the dial the row would tune), it
writes <dir>/dial.json with the estimated offset (true dial minus that dial,
kHz) and a confidence, and prints how many fall within 0.3 kHz.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

NFFT = 2048  # about 6 Hz a bin at 12 kHz: harmonics 70 Hz apart stay apart
HOP = 256
SPEECH_HZ = (150.0, 3000.0)  # where an SSB voice's harmonics are, from the true dial
MAX_OFFSET_HZ = 1000.0
F0_HZ = (70.0, 350.0)
VOICED = 0.35  # a frame's harmonicity (normalized spectral autocorrelation) to use it
MIN_FRAMES = 12  # voiced frames needed for an answer
PAIR_FRAMES = (8, 16)  # frames apart (about 170 and 340 ms) for the stretch: the pitch has to move
PAIR_RATIO = (0.02, 0.25)  # pitch changes between a pair's frames that count
MIN_PAIRS = 8
STRETCH_STEP_HZ = 10.0
MIN_CONFIDENCE = 2.0  # z-score margin of the stretch's pick over the next comb candidate


def _frames(iq: np.ndarray, rate: float, mode: str) -> tuple[np.ndarray, np.ndarray]:
    """Whitened log spectra (frames, bins) and each bin's offset from the tuned dial (Hz).

    LSB is mirrored so speech always sits above the dial: offsets are then
    measured downward in RF, and the caller flips the answer back.
    """
    win = np.hanning(NFFT)
    starts = range(0, iq.size - NFFT, HOP)
    spec = np.array([np.fft.fftshift(np.fft.fft(iq[s : s + NFFT] * win)) for s in starts])
    freqs = np.fft.fftshift(np.fft.fftfreq(NFFT, 1 / rate))
    if mode == "lsb":
        spec, freqs = spec[:, ::-1], -freqs[::-1]
    keep = (freqs >= SPEECH_HZ[0] - MAX_OFFSET_HZ) & (freqs <= SPEECH_HZ[1] + MAX_OFFSET_HZ)
    log = 10 * np.log10(np.abs(spec[:, keep]) ** 2 + 1e-12)
    # Take out the spectral envelope (about 300 Hz wide), leaving the harmonic ripple.
    width = max(3, int(300 / (rate / NFFT)))
    kernel = np.ones(width) / width
    smooth = np.array([np.convolve(row, kernel, mode="same") for row in log])
    ripple = np.clip(log - smooth, 0, 20)
    # Take out what doesn't move: a carrier or heterodyne would fit some comb in
    # every frame, while speech harmonics move with the pitch.
    return np.clip(ripple - np.median(ripple, axis=0), 0, 20), freqs[keep]


def _pitch(row: np.ndarray, df: float) -> tuple[float, float]:
    """The harmonic spacing in one frame and how harmonic it is (0..1)."""
    x = row - row.mean()
    ac = np.correlate(x, x, mode="full")[x.size - 1 :]
    if ac[0] <= 0:
        return 0.0, 0.0
    ac /= ac[0]
    lo, hi = int(F0_HZ[0] / df), int(F0_HZ[1] / df) + 1
    lag = lo + int(np.argmax(ac[lo:hi]))
    # Prefer the fundamental to a multiple: half the lag, if nearly as strong.
    half = lag // 2
    if half >= lo:
        near = half - 2 + int(np.argmax(ac[half - 2 : half + 3]))
        if ac[near] >= 0.8 * ac[lag]:
            lag = near
    # Refine to a fraction of a bin: the parabola through the peak.
    a, b, c = ac[lag - 1], ac[lag], ac[lag + 1] if lag + 1 < ac.size else ac[lag]
    shift = 0.5 * (a - c) / (a - 2 * b + c) if a - 2 * b + c < 0 else 0.0
    return (lag + shift) * df, float(b)


def _phase(row: np.ndarray, freqs: np.ndarray, f0: float) -> float:
    """Where the comb k * f0 + phase best fits this frame, phase in [0, f0)."""
    phases = np.arange(0, f0, 2.0)
    teeth = np.arange(np.floor((freqs[0]) / f0), np.ceil(freqs[-1] / f0) + 1) * f0
    pos = phases[:, None] + teeth[None, :]
    inside = (pos >= freqs[0]) & (pos <= freqs[-1])
    vals = np.where(inside, np.interp(pos, freqs, row), 0.0)
    return float(phases[int(np.argmax(vals.sum(axis=1)))])


def _stretch(spec: np.ndarray, freqs: np.ndarray, pitch: dict[int, float], deltas: np.ndarray) -> np.ndarray | None:
    """Summed z-scores, per candidate delta, of how well each voiced pair's
    later frame matches the earlier one stretched around delta."""
    total = np.zeros(deltas.size)
    pairs = 0
    for i, j in ((i, i + lag) for i in pitch for lag in PAIR_FRAMES):
        if j not in pitch:
            continue
        r = pitch[j] / pitch[i]
        if not PAIR_RATIO[0] <= abs(r - 1) <= PAIR_RATIO[1]:
            continue
        a, b = spec[i], spec[j]
        best = np.full(deltas.size, -np.inf)
        for rr in r * (1 + np.linspace(-0.015, 0.015, 7)):  # the pitch estimate is a few % off
            pos = deltas[:, None] + (freqs[None, :] - deltas[:, None]) * rr
            moved = np.interp(pos, freqs, b, left=0.0, right=0.0)
            best = np.maximum(best, (moved * a[None, :]).sum(axis=1))
        sd = best.std()
        if sd > 0:
            total += (best - best.mean()) / sd
            pairs += 1
    return total / np.sqrt(pairs) if pairs >= MIN_PAIRS else None


def estimate_offset(iq: np.ndarray, rate: float, mode: str) -> dict:
    """The true dial minus the tuned one, in kHz, with a confidence; None when it can't tell."""
    spec, freqs = _frames(iq, rate, mode)
    df = float(freqs[1] - freqs[0])
    pitch: dict[int, float] = {}
    f0s, phis, weights = [], [], []
    for i, row in enumerate(spec):
        f0, harmonic = _pitch(row, df)
        if harmonic < VOICED:
            continue
        pitch[i] = f0
        f0s.append(f0)
        phis.append(_phase(row, freqs, f0))
        weights.append(harmonic)
    coarse = np.arange(-MAX_OFFSET_HZ, MAX_OFFSET_HZ + 1, STRETCH_STEP_HZ)
    stretch = _stretch(spec, freqs, pitch, coarse) if len(f0s) >= MIN_FRAMES else None
    if stretch is None:
        return {"offsetKhz": None, "confidence": 0.0, "voicedFrames": len(f0s)}
    f0a, phia, wa = np.array(f0s), np.array(phis), np.array(weights)
    median_f0 = float(np.median(f0a))
    fine = np.arange(-MAX_OFFSET_HZ, MAX_OFFSET_HZ + 1, 2.0)
    comb = (wa[None, :] * np.cos(2 * np.pi * (fine[:, None] - phia[None, :]) / f0a[None, :])).sum(axis=1) / wa.sum()
    # The comb's candidates (one per pitch step), ranked by the stretch.
    peaks = [k for k in range(1, fine.size - 1) if comb[k] >= comb[k - 1] and comb[k] > comb[k + 1]]
    peaks = [k for k in peaks if comb[k] >= 0.5 * comb.max()]
    ranked = sorted(peaks, key=lambda k: -float(np.interp(fine[k], coarse, stretch)))
    if not ranked:
        return {"offsetKhz": None, "confidence": 0.0, "voicedFrames": len(f0s)}
    lead = float(np.interp(fine[ranked[0]], coarse, stretch))
    rival = float(np.interp(fine[ranked[1]], coarse, stretch)) if len(ranked) > 1 else float(stretch.min())
    confidence = lead - rival
    delta = float(fine[ranked[0]])
    if mode == "lsb":
        delta = -delta  # mirrored: an offset up the mirrored axis is down in RF
    ok = confidence >= MIN_CONFIDENCE
    return {
        "offsetKhz": round(delta / 1000, 3) if ok else None,
        "confidence": round(confidence, 3),
        "voicedFrames": len(f0s),
        "medianF0Hz": round(median_f0),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", type=Path, nargs="+")
    args = ap.parse_args()
    results = []
    for folder in args.dirs:
        clips = json.loads((folder / "clips.json").read_text())
        out = []
        for clip in clips:
            if clip["kind"] != "voice" or "iq" not in clip:
                continue
            data = np.load(folder / clip["iq"])
            est = estimate_offset(data["iq"], float(data["rate"]), clip["mode"])
            out.append({**clip, **est})
        (folder / "dial.json").write_text(json.dumps(out, indent=1))
        results += [(folder.name, r) for r in out]
    told = [(name, r) for name, r in results if r["offsetKhz"] is not None]
    print(f"{len(results)} voice clips, {len(told)} with a confident dial")
    for source in ("both", "detector-only", "labeler-only"):
        mine = [r for _n, r in told if r["source"] == source]
        if mine:
            good = sum(abs(r["offsetKhz"]) <= 0.3 for r in mine)
            print(f"  {source:13s} {good}/{len(mine)} within 0.3 kHz of the true dial")
    for name, r in told:
        print(f"  {name} {r['band']} {r['freqKhz']} {r['mode']}: true dial {r['offsetKhz']:+.3f} kHz (conf {r['confidence']})")


if __name__ == "__main__":
    main()
