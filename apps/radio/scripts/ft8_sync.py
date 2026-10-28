"""Find FT8 signals in record_ham.py's saved slots by their sync pattern.

    python scripts/ft8_sync.py spike/kiwi1 spike/kiwi2

An independent check on the digital rows: the detector and auto_label.py both
call an FT8 window busy from energy in it, so they can agree and both be
wrong. Every FT8 transmission carries three 7x7 Costas arrays (tones 3 1 4 0
6 5 2 at symbols 0-6, 36-42 and 72-78; 8 tones 6.25 Hz apart, 0.16 s a
symbol). Matching that pattern is the first stage of a real decoder and works
far below what an ear can hear, so it says whether FT8 is there at all. Each
signal's SNR is given in 2.5 kHz, as FT8 software reports it: around -10 dB
and below, a listener hears noise even though a decoder would copy it.

This finds signals; it doesn't decode them (no LDPC or CRC), so a few
strong-looking matches can still be chance: MIN_SYNC is set well above what
noise reaches.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

COSTAS = (3, 1, 4, 0, 6, 5, 2)
SYNC_AT = (0, 36, 72)
SYMBOL_S = 0.16
TONE_HZ = 6.25
AUDIO_HZ = (100.0, 3100.0)  # where FT8 traffic sits above the dial
STEPS_PER_SYMBOL = 4
FREQ_STEPS_PER_TONE = 2
START_S = (0.0, 3.0)  # where symbol 0 can fall in a slot capture (it began 0.5 s early)
MIN_SYNC = 8.0  # sync score (signal over the other tones, in noise standard deviations) to count
BANDWIDTH_HZ = 2500.0
HANN_NOISE_HZ = 1.5 / SYMBOL_S


def _power(iq: np.ndarray, rate: float) -> tuple[np.ndarray, np.ndarray, float]:
    """Power per (time step, frequency step) over the FT8 audio range, symbol-long FFTs."""
    n = int(round(rate * SYMBOL_S))
    hop = n // STEPS_PER_SYMBOL
    nfft = n * FREQ_STEPS_PER_TONE
    win = np.hanning(n)
    starts = range(0, iq.size - n, hop)
    spec = np.array([np.fft.fft(iq[s : s + n] * win, nfft) for s in starts])
    freqs = np.fft.fftfreq(nfft, 1 / rate)
    keep = (freqs >= AUDIO_HZ[0]) & (freqs <= AUDIO_HZ[1])
    order = np.argsort(freqs[keep])
    return np.abs(spec[:, keep][:, order]) ** 2, freqs[keep][order], hop / rate


def find_signals(iq: np.ndarray, rate: float) -> list[dict]:
    """FT8 signals in one slot: their audio frequency, start time, sync score and SNR."""
    power, freqs, step_s = _power(iq, rate)
    times, nf = power.shape
    noise = float(np.median(power))
    tone = FREQ_STEPS_PER_TONE
    t_lo, t_hi = int(START_S[0] / step_s), int(START_S[1] / step_s)
    last = (SYNC_AT[-1] + 6) * STEPS_PER_SYMBOL
    t_hi = min(t_hi, times - last - 1)
    f_hi = nf - 8 * tone
    if t_hi <= t_lo or f_hi <= 0:
        return []
    score = np.zeros((t_hi - t_lo, f_hi))
    sig = np.zeros_like(score)
    for t in range(t_lo, t_hi):
        for block in SYNC_AT:
            for k, c in enumerate(COSTAS):
                row = power[t + (block + k) * STEPS_PER_SYMBOL]
                tones = np.stack([row[j * tone : j * tone + f_hi] for j in range(8)])
                want = tones[c]
                others = (tones.sum(axis=0) - want) / 7
                score[t - t_lo] += want - others
                sig[t - t_lo] += want
    # Standardize against what noise gives: most (time, frequency) cells hold no signal.
    z = (score - np.median(score)) / (1.4826 * np.median(np.abs(score - np.median(score))) + 1e-12)
    found: list[dict] = []
    taken = np.zeros_like(z, dtype=bool)
    for idx in np.argsort(z, axis=None)[::-1]:
        t, f = np.unravel_index(idx, z.shape)
        if z[t, f] < MIN_SYNC:
            break
        if taken[t, f]:
            continue
        # A strong signal also half-matches at other start times and nearby tones;
        # two can't share a frequency in one slot, so it claims its 8 tones either
        # side for the whole slot.
        taken[:, max(0, f - 8 * tone) : f + 8 * tone] = True
        per_symbol = sig[t, f] / (len(SYNC_AT) * len(COSTAS))
        # Tone power over the noise in one bin (a Hann window's noise bandwidth,
        # 1.5 / SYMBOL_S Hz), scaled to the 2.5 kHz FT8 software reports against.
        snr = 10 * np.log10(max(per_symbol / noise - 1, 1e-6) * HANN_NOISE_HZ / BANDWIDTH_HZ)
        found.append(
            {
                "audioHz": round(float(freqs[f])),
                "startS": round((t + t_lo) * step_s, 2),
                "sync": round(float(z[t, f]), 1),
                "snrDb": round(float(snr), 1),
            }
        )
    return found


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", type=Path, nargs="+")
    args = ap.parse_args()
    for folder in args.dirs:
        out = {}
        for path in sorted((folder / "ft8").glob("*.npz")):
            data = np.load(path)
            sigs = find_signals(data["iq"], float(data["rate"]))
            out[path.name] = {"dialKhz": float(data["dial_khz"]), "utc": str(data["start_utc"]), "signals": sigs}
            loud = sum(s["snrDb"] >= -10 for s in sigs)
            print(f"{folder.name} {path.name}: {len(sigs)} FT8 signals, {loud} at -10 dB or better")
        (folder / "ft8.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    sys.exit(main())
