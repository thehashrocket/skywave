"""Synthesize an I/Q WAV with known signals, for testing DSP without a receiver.

    python scripts/make_test_signal.py --out synthetic.wav

Contents (offsets from the tuned frequency):
    0 kHz      AM carrier, 30% modulated with a 440 Hz tone
    +2.0 kHz   a steady tone: a 2 kHz whistle in USB, silent in LSB
    -3.5 kHz   a CW carrier keyed on and off, outside the SSB and CW passbands
plus a little noise. Try every mode on it and see what each one lets through.
"""

from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

import numpy as np


def synth(rate: float = 12000.0, seconds: float = 5.0, seed: int = 1) -> np.ndarray:
    t = np.arange(int(rate * seconds)) / rate
    rng = np.random.default_rng(seed)
    am = 0.25 * (1 + 0.3 * np.sin(2 * np.pi * 440 * t))
    tone = 0.05 * np.exp(2j * np.pi * 2000 * t)
    keying = (np.sin(2 * np.pi * 2 * t) > 0).astype(float)
    cw = 0.08 * keying * np.exp(-2j * np.pi * 3500 * t)
    noise = 0.002 * (rng.standard_normal(t.size) + 1j * rng.standard_normal(t.size))
    return (am + tone + cw + noise).astype(np.complex64)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, default=Path("synthetic.wav"))
    p.add_argument("--seconds", type=float, default=5)
    a = p.parse_args()
    rate = 12000.0
    iq = synth(rate, a.seconds)
    inter = np.empty(iq.size * 2, dtype="<i2")
    inter[0::2] = np.clip(iq.real * 32768, -32768, 32767)
    inter[1::2] = np.clip(iq.imag * 32768, -32768, 32767)
    with wave.open(str(a.out), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(int(rate))
        w.writeframes(inter.tobytes())
    a.out.with_suffix(a.out.suffix + ".json").write_text(json.dumps({"sampleRate": rate, "synthetic": True}))
    print(f"Wrote {a.out}")


if __name__ == "__main__":
    main()
