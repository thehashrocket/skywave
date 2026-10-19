"""Plot the average spectrum and a waterfall of a recorded I/Q WAV.

    python scripts/plot_spectrum.py capture.wav            # opens a window
    python scripts/plot_spectrum.py capture.wav --out spectrum.png
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from iqwav import read_iq_wav  # noqa: E402
from skywave_radio.dsp import Spectrum  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("wav", type=Path)
    p.add_argument("--out", type=Path, help="save to PNG instead of opening a window")
    a = p.parse_args()

    import matplotlib

    if a.out:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    iq, rate = read_iq_wav(a.wav)
    spectrum = Spectrum(rate, nfft=2048, bins=1024, rate_hz=20)
    frames = spectrum.process(iq)
    rows_per_s = rate / spectrum.hop
    if not frames:
        raise SystemExit("Recording too short for a spectrum.")
    rows = np.stack([f.db for f in frames])
    freqs = np.linspace(-rate / 2, rate / 2, rows.shape[1]) / 1000
    floor, peak = np.percentile(rows, 5), rows.max()

    fig, (top, bottom) = plt.subplots(2, 1, figsize=(10, 7), sharex=True, height_ratios=[1, 2])
    top.plot(freqs, rows.mean(axis=0), lw=0.8)
    top.set_ylabel("dBFS")
    top.set_title(f"{a.wav.name}  ({rate:.0f} Hz I/Q, 0 kHz = tuned frequency)")
    top.grid(alpha=0.3)
    bottom.imshow(
        rows,
        aspect="auto",
        origin="upper",
        extent=(freqs[0], freqs[-1], rows.shape[0] / rows_per_s, 0),
        vmin=floor,
        vmax=peak,
        cmap="magma",
    )
    bottom.set_xlabel("Offset from tuned frequency (kHz)")
    bottom.set_ylabel("Seconds")
    fig.tight_layout()
    if a.out:
        fig.savefig(a.out, dpi=120)
        print(f"Wrote {a.out}")
    else:
        plt.show()


if __name__ == "__main__":
    main()
