import json
import subprocess
import sys
from pathlib import Path

import numpy as np

from skywave_radio.scan import HAM_SEGMENTS, plan_frames

from .test_scan import HAM_SPAN, ham_frame

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "eval_ham.py"
UTC = "2026-11-01T14:00:00+00:00"


def write_round(folder: Path, voices) -> None:
    """One round-01.npz as record_ham.py writes it, with SSB voices (lo, hi, dB) on 20m."""
    plans = plan_frames(bands=HAM_SEGMENTS)
    frames = [ham_frame(p.cf_khz - HAM_SPAN / 2, voices=voices if p.band.name == "20m" else ()) for p in plans]
    np.savez_compressed(
        folder / "round-01.npz",
        utc=UTC,
        offset_khz=0.0,
        bins=np.stack([f.bins for f in frames]),
        start_khz=np.array([f.start_khz for f in frames]),
        span_khz=np.array([f.span_khz for f in frames]),
        zoom=np.array([f.zoom for f in frames]),
        segment=np.array([f"{p.band.name}|{p.band.kind}|{p.lo_khz}|{p.hi_khz}|{p.cf_khz}" for p in plans]),
    )


def score(folder: Path, labels: list[dict]) -> subprocess.CompletedProcess:
    (folder / "labels.json").write_text(json.dumps(labels))
    return subprocess.run([sys.executable, str(SCRIPT), str(folder)], capture_output=True, text=True, timeout=60)


# Value: protects=rows nobody labeled count as false only on bands the labeler marked complete; elsewhere they are listed to check by ear, so partial labels can't fail a correct detector (user, spike review); fails_when=eval counts every unlabeled row as false again; why_new=user caught it in review; seam=none; no_claim=what a real labeler hears
def test_unlabeled_rows_count_only_on_bands_marked_complete(tmp_path):
    write_round(tmp_path, [(14_251.6, 14_254.0, 25), (14_301.6, 14_304.0, 25)])
    heard = {"utc": UTC, "kind": "voice", "freqKhz": 14_251.3, "mode": "usb"}
    partial = score(tmp_path, [heard])
    voice = next(line for line in partial.stdout.splitlines() if line.startswith("voice"))
    assert "found 100%" in voice and "false unchecked" in voice
    assert "check them by ear" in partial.stdout and "14301" in partial.stdout
    marked = score(tmp_path, [heard, {"utc": UTC, "kind": "complete", "band": "20m", "kinds": ["voice"]}])
    voice = next(line for line in marked.stdout.splitlines() if line.startswith("voice"))
    assert "false 1.0/round" in voice  # the unlabeled 14,301 voice now counts


# Value: protects=the pass bar itself: found and accurate (within 0.3 kHz) at 80%, labels matched to a round only within the window, PASS/FAIL and the exit code (plan R7); fails_when=a cutoff, the window or the exit code drifts, so the spike's verdict is wrong; why_new=review: only the false-row rule was tested; seam=none; no_claim=what a real labeler hears
def test_the_pass_bar_and_label_window(tmp_path):
    write_round(tmp_path, [(14_251.6, 14_254.0, 25)])
    complete = {"utc": UTC, "kind": "complete", "band": "20m", "kinds": ["voice"]}
    near = {"utc": UTC, "kind": "voice", "freqKhz": 14_251.3, "mode": "usb"}
    off = {"utc": UTC, "kind": "voice", "freqKhz": 14_252.1, "mode": "usb"}  # found (within 1 kHz), not accurate
    late = {"utc": "2026-11-01T14:02:00+00:00", "kind": "voice", "freqKhz": 14_301.3, "mode": "usb"}

    def voice(result):
        return next(line for line in result.stdout.splitlines() if line.startswith("voice"))

    passed = score(tmp_path, [near, complete])
    assert "found 100%  accurate 100%  false 0.0/round  PASS" in voice(passed)
    sloppy = score(tmp_path, [off, complete])
    assert "found 100%  accurate   0%" in voice(sloppy) and "FAIL" in voice(sloppy)
    assert sloppy.returncode == 1
    # Two minutes after the round: outside the 90 s window, so it isn't counted at all.
    assert "labels   1" in voice(score(tmp_path, [near, late, complete]))


# Value: protects=--set takes JSON, merges a dict constant and type-checks a number, so the spike can tune every provisional threshold (review); fails_when=dict constants can't be set or a bad value is silently cast; why_new=review found dicts couldn't be set; seam=none; no_claim=none beyond protects
def test_set_overrides_numbers_and_dicts(tmp_path):
    write_round(tmp_path, [(14_251.6, 14_254.0, 25)])
    (tmp_path / "labels.json").write_text("[]")

    def run(*sets):
        args = [sys.executable, str(SCRIPT), str(tmp_path)] + [a for s in sets for a in ("--set", s)]
        return subprocess.run(args, capture_output=True, text=True, timeout=60)

    found = run().stdout
    assert "14251" in found or "14,251" in found
    assert "14251" not in run("HAM_MIN_SNR_DB=40").stdout  # the voice is 25 dB up: too quiet now
    assert run('HAM_MERGE_KHZ={"voice": 0.5}').returncode == 1  # ran (exit 1: no labels), not a usage error
    bad = run('HAM_MIN_SNR_DB="loud"')
    assert "expected a float" in bad.stderr or "expected a float" in bad.stdout
