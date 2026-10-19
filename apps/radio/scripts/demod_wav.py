"""Demodulate a recorded I/Q WAV into an audio WAV you can play.

    python scripts/demod_wav.py capture.wav --mode am --out capture-audio.wav

This is the same Demodulator the live service uses, fed in 100 ms blocks to
mimic streaming. Edit skywave_radio/dsp.py, rerun, listen. That's the loop.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from iqwav import read_iq_wav, write_audio_wav  # noqa: E402
from skywave_radio.dsp import MODES, Demodulator  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("wav", type=Path)
    p.add_argument("--mode", choices=MODES, default="am")
    p.add_argument("--out", type=Path)
    a = p.parse_args()

    iq, rate = read_iq_wav(a.wav)
    demod = Demodulator(rate, a.mode)
    block = int(rate / 10)
    audio = np.concatenate([demod.process(iq[i : i + block]) for i in range(0, iq.size, block)])
    out = a.out or a.wav.with_name(f"{a.wav.stem}-{a.mode}.wav")
    write_audio_wav(out, audio, rate)
    print(f"Wrote {out} ({audio.size / rate:.1f}s, {a.mode.upper()})")


if __name__ == "__main__":
    main()
