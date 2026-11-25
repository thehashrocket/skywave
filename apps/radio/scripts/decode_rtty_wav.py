"""Decode RTTY from a recorded I/Q WAV (record_iq.py / record_window.py output).

    python scripts/decode_rtty_wav.py capture.wav [--reverse] [--mark 1585] [--search -4800 4800]

Runs the radio service's RttyDecoder over the file as the live session would,
and prints the text with the time into the file and the tone pair it locked on.
By default it searches the whole ±5 kHz the Kiwi sends, so the dial needn't be
set for USB. Run it with and without --reverse to see which polarity a station uses.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from iqwav import read_iq_wav  # noqa: E402

from skywave_radio.rtty import RttyDecoder  # noqa: E402

BLOCK = 512


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("wav", type=Path, nargs="+")
    p.add_argument("--reverse", action="store_true")
    p.add_argument("--mark", type=float, default=None, help="mark tone, Hz from the dial (default: find it)")
    p.add_argument("--search", type=float, nargs=2, default=(-4800.0, 4800.0), metavar=("LOW", "HIGH"))
    a = p.parse_args()
    for path in a.wav:
        iq, rate = read_iq_wav(path)
        d = RttyDecoder(rate, mark_hz=a.mark, reverse=a.reverse, search=tuple(a.search))
        print(f"== {path} ({iq.size / rate:.0f} s at {rate:.2f} Hz, {'reverse' if a.reverse else 'normal'})")
        line_start: float | None = None
        line = ""
        for i in range(0, iq.size, BLOCK):
            text = d.process(iq[i : i + BLOCK])
            if text and line_start is None:
                line_start = i / rate
                print(f"[{line_start:7.1f} s, mark {d.mark_hz:.0f} Hz, pair {d.snr_db:.0f} dB]")
            line += text
            if "\n" in line:
                *done, line = line.split("\n")
                for ln in done:
                    print("  " + ln)
            if not d.squelch_open and line_start is not None:
                if line:
                    print("  " + line)
                line, line_start = "", None
        if line:
            print("  " + line)


if __name__ == "__main__":
    main()
