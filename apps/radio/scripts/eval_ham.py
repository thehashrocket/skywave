"""Score the ham detector on frames from record_ham.py against hand labels.

    python scripts/eval_ham.py spike/kiwi1 spike/kiwi2 [--set HAM_MIN_SNR_DB=12 ...]

For each directory: its round-NN.npz frames and labels.json. A label counts
only for the round closest to its time, and only if that round started within
--window seconds (90 by default) of it: note the UTC time of each label.

labels.json holds two kinds of entry:

  {"utc": ..., "kind": "voice" | "cw" | "digital", "freqKhz": ..., "mode": ...}
      a signal you heard (freqKhz is the dial you tuned; for CW the signal)
  {"utc": ..., "kind": "complete", "band": "20m"}
      "I labeled everything real I could hear on 20m at this time"; add
      "kinds": ["voice"] to vouch for only some groups

Reports, per group (voice, cw, digital):

  found     labeled signals with a listed row within --near kHz
  accurate  of those, rows within 0.3 kHz of the labeled dial
  false     rows with no label near them, on bands marked complete for that
            round, per round that has any band marked complete

Rows with no label on bands NOT marked complete are listed for checking by
ear; they don't count against the detector, since an unlabeled row there may
just be a signal nobody wrote down. Without any "complete" entries the false
rate is unknown, so the bar can't pass.

The pass bar (plan R7): found >= 80%, accurate >= 80%, false <= 1 per round
per group. --set overrides a scan.py constant, to tune the provisional
thresholds before writing the winners into scan.py. Its value is JSON, so a
dict works too: --set 'HAM_MERGE_KHZ={"voice": 1.0}' (merged into the dict).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from skywave_radio import scan  # noqa: E402
from skywave_radio.waterfall import WaterfallFrame  # noqa: E402

KINDS = ("voice", "cw", "digital")


def rounds_in(folder: Path) -> list[tuple[datetime, dict[str, list[dict]]]]:
    out = []
    for path in sorted(folder.glob("round-*.npz")):
        data = np.load(path)
        offset = float(data["offset_khz"])
        found = []
        for i, seg in enumerate(data["segment"]):
            name, kind, lo, hi, cf = str(seg).split("|")
            zoom = int(data["zoom"][i])
            plan = scan.FramePlan(scan.Band(name, float(lo), float(hi), zoom, kind), float(cf), float(lo), float(hi))
            frame = WaterfallFrame(zoom, float(data["start_khz"][i]), float(data["span_khz"][i]), data["bins"][i])
            found += scan.find_ham(frame, plan, offset)
        result = scan.summarize_ham(found, 1, 1)
        out.append((datetime.fromisoformat(str(data["utc"])), {k: getattr(result, k) for k in KINDS}))
    return out


def score(dirs: list[Path], near: float = 1.0, window: float = 90.0) -> tuple[dict, list[str]]:
    """Per-group counts over every directory, and the unlabeled rows to check by ear."""
    stats = {k: {"labels": 0, "found": 0, "accurate": 0, "false": 0, "checked_rounds": 0} for k in KINDS}
    to_check: list[str] = []
    for folder in dirs:
        labels = json.loads((folder / "labels.json").read_text())
        rounds = rounds_in(folder)
        used: dict[int, list[dict]] = {}
        for label in labels:
            at = datetime.fromisoformat(label["utc"].replace("Z", "+00:00"))
            i = min(range(len(rounds)), key=lambda r: abs((rounds[r][0] - at).total_seconds()))
            if abs((rounds[i][0] - at).total_seconds()) <= window:
                used.setdefault(i, []).append(label)
        for i, (when, rows) in enumerate(rounds):
            mine = used.get(i, [])
            for kind in KINDS:
                st = stats[kind]
                wanted = [lab for lab in mine if lab["kind"] == kind]
                complete = {
                    lab["band"] for lab in mine if lab["kind"] == "complete" and kind in lab.get("kinds", KINDS)
                }
                if complete:
                    st["checked_rounds"] += 1
                for lab in wanted:
                    st["labels"] += 1
                    close = [r for r in rows[kind] if abs(r["freqKhz"] - lab["freqKhz"]) <= near]
                    if close:
                        st["found"] += 1
                        if min(abs(r["freqKhz"] - lab["freqKhz"]) for r in close) <= 0.3:
                            st["accurate"] += 1
                for r in rows[kind]:
                    if any(abs(r["freqKhz"] - lab["freqKhz"]) <= near for lab in wanted):
                        continue
                    if r["band"] in complete:
                        st["false"] += 1
                    else:
                        to_check.append(f"  {folder.name} {when:%H:%M:%S}Z  {kind:7s} {r['band']:4s} {r['freqKhz']} kHz")
    return stats, to_check


def passes(st: dict) -> tuple[bool, float | None, float | None, float | None]:
    """The R7 bar for one group: (passed, found, accurate, false per round)."""
    found = st["found"] / st["labels"] if st["labels"] else None
    accurate = st["accurate"] / st["found"] if st["found"] else None
    false = st["false"] / st["checked_rounds"] if st["checked_rounds"] else None
    ok = (
        found is not None
        and found >= 0.8
        and accurate is not None
        and accurate >= 0.8
        and false is not None
        and false <= 1.0
    )
    return ok, found, accurate, false


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", type=Path, nargs="+")
    ap.add_argument("--set", action="append", default=[], metavar="NAME=VALUE")
    ap.add_argument("--near", type=float, default=1.0, help="kHz within which a row finds a label")
    ap.add_argument("--window", type=float, default=90.0, help="seconds a label stays valid around a round")
    args = ap.parse_args()
    for item in args.set:
        name, value = item.split("=", 1)
        if not hasattr(scan, name):
            sys.exit(f"scan.py has no {name}")
        old = getattr(scan, name)
        new = json.loads(value)
        if isinstance(old, dict) and isinstance(new, dict):
            new = {**old, **new}
        elif isinstance(old, (int, float)) and not isinstance(old, bool) and isinstance(new, (int, float)):
            new = type(old)(new)
        else:
            sys.exit(f"--set {name}: expected a {type(old).__name__}, got {value}")
        setattr(scan, name, new)

    stats, to_check = score(args.dirs, args.near, args.window)
    ok = True
    for kind, st in stats.items():
        passed, found, accurate, false = passes(st)
        ok &= passed
        pct = lambda x: "n/a" if x is None else f"{x:.0%}"  # noqa: E731
        shown = "unchecked (no band marked complete)" if false is None else f"{false:.1f}/round"
        print(
            f"{kind:8s} labels {st['labels']:3d}  found {pct(found):>4s}  accurate {pct(accurate):>4s}  "
            f"false {shown}  {'PASS' if passed else 'FAIL'}"
        )
    if to_check:
        print(f"\n{len(to_check)} listed rows on bands not marked complete; check them by ear:")
        print("\n".join(to_check))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
