"""Spike (#61): does DVOACAP-Python predict which KiwiSDRs heard a station?

Scores DVOACAP circuit reliability, SNR and MUF against the VE3SUN listener
reports (heard / not heard) and against a distance-only baseline, then times
the engine for the "rank 50 receivers now" request.

    pip install -e 'apps/radio[forecast]'
    python apps/radio/spikes/dvoacap/score_ve3sun.py score --paths <ve3sun-reception-paths.csv>
    python apps/radio/spikes/dvoacap/score_ve3sun.py bench --paths <ve3sun-reception-paths.csv>

Only aggregate numbers are printed. Per-row predictions are written next to
the input CSV (inside .local-data/, which git never sees), never into the repo.

Inputs and assumptions (also in RESULTS.md):
- utc is treated as UTC and rounded to the nearest hour, as VOACAP is hourly.
- SSN: SILSO monthly 13-month smoothed total sunspot number, version 2
  (SN_ms_tot_V2.0.csv), for the report's calendar month. Downloaded once to
  ~/.cache/skywave-spike/. --ssn-scale 0.6 approximates the pre-2015 V1 scale
  that VOACAP's ionospheric maps were fitted to.
- Isotropic antennas both ends, 145 dB man-made noise at 3 MHz (residential;
  the dvoacap default), 3 degree minimum takeoff angle.
- TX power and required SNR (dB in 1 Hz, as dvoacap computes noise per Hz)
  depend on the logged mode; see MODE_PROFILES. These are guesses, which is
  why raw SNR and MUF are scored too: neither depends on them.
- VOACAP covers 2-30 MHz skywave only; rows outside 2-30 MHz are dropped
  from every score, the distance baseline included, so all scores see the
  same rows.
"""

from __future__ import annotations

import argparse
import csv
import math
import os
import random
import resource
import statistics
import sys
import time
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from dvoacap.path_geometry import GeoPoint
from dvoacap.prediction_engine import PredictionEngine
from scipy.stats import rankdata

SILSO_URL = "https://www.sidc.be/SILSO/INFO/snmstotcsv.php"
SILSO_CACHE = Path.home() / ".cache" / "skywave-spike" / "SN_ms_tot_V2.0.csv"

# mode -> (tx power W, required SNR dB-Hz). Listener-grade, not broadcast-grade.
MODE_PROFILES = {
    "cw": (100.0, 30.0),
    "ssb": (100.0, 44.0),
    "am": (100_000.0, 54.0),  # HF 'am' reports are almost all SW broadcasters
}
BANDS = [(2, 4), (4, 6), (6, 8), (8, 11), (11, 15), (15, 19), (19, 22), (22, 30)]
DIST_BINS = [(0, 1000), (1000, 3000), (3000, 7000), (7000, 10000), (10000, 21000)]


def mode_profile(mode: str) -> str:
    m = mode.strip().lower()
    if m.startswith("cw"):
        return "cw"
    if m in ("am", "amn", "sam"):
        return "am"
    return "ssb"  # usb, lsb and blank


def load_ssn(scale: float) -> dict[tuple[int, int], float]:
    if not SILSO_CACHE.exists():
        SILSO_CACHE.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(SILSO_URL, SILSO_CACHE)
    table = {}
    with SILSO_CACHE.open() as f:
        for row in csv.reader(f, delimiter=";"):
            year, month, value = int(row[0]), int(row[1]), float(row[3])
            if value >= 0:  # -1 marks months not yet smoothed
                table[(year, month)] = value * scale
    return table


@dataclass
class Row:
    when: datetime
    mhz: float
    profile: str
    rx: tuple[float, float]
    tx: tuple[float, float]
    tx_key: str
    path_km: float
    heard: bool


def load_rows(path: Path) -> tuple[list[Row], int]:
    rows, dropped = [], 0
    with path.open() as f:
        for r in csv.DictReader(f):
            mhz = float(r["khz"]) / 1000
            if not 2.0 <= mhz <= 30.0:
                dropped += 1
                continue
            rows.append(Row(
                when=datetime.strptime(r["utc"], "%Y-%m-%d %H:%M:%S"),
                mhz=mhz,
                profile=mode_profile(r["mode"]),
                rx=(float(r["rx_lat"]), float(r["rx_lon"])),
                tx=(float(r["tx_lat"]), float(r["tx_lon"])),
                tx_key=r["tx_grid"].upper(),
                path_km=float(r["path_km"]),
                heard=r["outcome"] == "heard",
            ))
    return rows, dropped


def nearest_hour(when: datetime) -> int:
    return (when.hour + (1 if when.minute >= 30 else 0)) % 24


def predict(engine: PredictionEngine, ssn: float, month: int, hour: int,
            tx: tuple[float, float], rx: tuple[float, float], mhz: float,
            profile: str) -> tuple[float, float, float]:
    power, req_snr = MODE_PROFILES[profile]
    p = engine.params
    p.ssn, p.month, p.tx_power, p.required_snr = ssn, month, power, req_snr
    p.tx_location = GeoPoint.from_degrees(*tx)
    engine.predict(GeoPoint.from_degrees(*rx), hour / 24.0, [mhz])
    pred = engine.predictions[0]
    return float(pred.signal.reliability), float(pred.signal.snr_db), float(engine.circuit_muf.muf)


def midpoint_sun_elevation(r: Row) -> float:
    """Solar elevation (degrees) at the great-circle midpoint of the path."""
    la1, lo1, la2, lo2 = map(math.radians, (*r.tx, *r.rx))
    bx = math.cos(la2) * math.cos(lo2 - lo1)
    by = math.cos(la2) * math.sin(lo2 - lo1)
    lat = math.atan2(math.sin(la1) + math.sin(la2), math.hypot(math.cos(la1) + bx, by))
    lon = lo1 + math.atan2(by, math.cos(la1) + bx)
    day = r.when.timetuple().tm_yday
    decl = math.radians(-23.44) * math.cos(2 * math.pi * (day + 10) / 365)
    hour_angle = math.radians(15 * (r.when.hour + r.when.minute / 60 - 12)) + lon
    sin_el = math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(hour_angle)
    return math.degrees(math.asin(max(-1.0, min(1.0, sin_el))))


def day_night_heuristic(r: Row) -> float:
    """Rule of thumb, no model: bands above 10 MHz work when the path midpoint
    is sunlit, bands below it when it is dark. A floor for 'is there any
    propagation signal in these reports at all?'."""
    sun = midpoint_sun_elevation(r)
    return sun if r.mhz >= 10 else -sun


def receiver_track_record(rows: list[Row], prior_n: float = 5.0) -> np.ndarray:
    """Each report scored by its receiver's heard rate over strictly earlier
    reports (receiver = 4-char grid), shrunk toward the overall rate seen so
    far. Uses only the past, as a live ranker would, so it cannot peek."""
    by_time: dict[datetime, list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        by_time[r.when].append(i)
    out = np.empty(len(rows))
    seen: dict[tuple[float, float], list[int]] = defaultdict(lambda: [0, 0])
    total_heard = total = 0
    for when in sorted(by_time):
        batch = by_time[when]
        prior = (total_heard + 1) / (total + 2)
        for i in batch:  # score the whole timestamp before learning from it
            h, n = seen[rows[i].rx]
            out[i] = (h + prior_n * prior) / (n + prior_n)
        for i in batch:
            seen[rows[i].rx][0] += rows[i].heard
            seen[rows[i].rx][1] += 1
        total_heard += sum(rows[i].heard for i in batch)
        total += len(batch)
    return out


# ---------------------------------------------------------------- scoring

def auc(score: np.ndarray, heard: np.ndarray) -> float:
    """ROC AUC via Mann-Whitney U, ties count half."""
    ok = ~np.isnan(score)
    score, heard = score[ok], heard[ok]
    n_pos, n_neg = heard.sum(), (~heard).sum()
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    ranks = rankdata(score)
    return float((ranks[heard].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def auc_ci(score: np.ndarray, heard: np.ndarray, n_boot: int = 1000) -> tuple[float, float]:
    rng = np.random.default_rng(61)
    idx = rng.integers(0, len(score), size=(n_boot, len(score)))
    vals = sorted(auc(score[i], heard[i]) for i in idx)
    return vals[int(0.025 * n_boot)], vals[int(0.975 * n_boot)]


def deciles(score: np.ndarray, heard: np.ndarray) -> list[tuple[float, float, int, float]]:
    """(score lo, score hi, n, heard rate) per rank decile; tied scores share a bin."""
    ranks = rankdata(score)  # average ranks, so ties land in one bin
    bins = np.minimum(((ranks - 1) / len(score) * 10).astype(int), 9)
    out = []
    for b in range(10):
        m = bins == b
        if m.any():
            out.append((score[m].min(), score[m].max(), int(m.sum()), heard[m].mean()))
    return out


def grouped_concordance(groups: list[np.ndarray], score: np.ndarray, heard: np.ndarray) -> tuple[float, int]:
    """Within each group (same station, frequency, hour), the share of
    (heard, not heard) receiver pairs where the heard one scored higher.
    This is the ranking question itself: who should we pick for this signal?"""
    good, pairs = 0.0, 0
    for g in groups:
        pos, neg = score[g][heard[g]], score[g][~heard[g]]
        for s in pos:
            good += (s > neg).sum() + 0.5 * (s == neg).sum()
        pairs += len(pos) * len(neg)
    return good / pairs if pairs else float("nan"), pairs


def fmt(x: float, nd: int = 3) -> str:
    return "n/a" if math.isnan(x) else f"{x:.{nd}f}"


def score_cmd(args: argparse.Namespace) -> None:
    rows, dropped = load_rows(args.paths)
    ssn_table = load_ssn(args.ssn_scale)
    if args.sample:
        rows = random.Random(61).sample(rows, min(args.sample, len(rows)))
    # Sort so consecutive predictions share month/SSN/hour; FourierMaps
    # only re-interpolates its coefficients when those change.
    rows.sort(key=lambda r: (r.when.year, r.when.month, nearest_hour(r.when)))

    engine = PredictionEngine()
    rel = np.full(len(rows), np.nan)
    snr = np.full(len(rows), np.nan)
    muf = np.full(len(rows), np.nan)
    failures: dict[str, int] = defaultdict(int)
    t0 = time.perf_counter()
    for i, r in enumerate(rows):
        ssn = ssn_table.get((r.when.year, r.when.month))
        if ssn is None:
            failures["no SSN for month"] += 1
            continue
        try:
            rel[i], snr[i], muf[i] = predict(engine, ssn, r.when.month, nearest_hour(r.when),
                                             r.tx, r.rx, r.mhz, r.profile)
        except Exception as e:  # noqa: BLE001 - count, don't hide
            failures[type(e).__name__] += 1
            engine = PredictionEngine()  # don't trust state after a failure
    elapsed = time.perf_counter() - t0

    heard = np.array([r.heard for r in rows])
    dist = np.array([r.path_km for r in rows])
    mhz = np.array([r.mhz for r in rows])
    ok = ~np.isnan(rel)
    scores = {
        "DVOACAP reliability": rel,
        "DVOACAP SNR": snr,
        "DVOACAP MUF / f": muf / mhz,
        "distance baseline (-path_km)": -dist,
        "day/night heuristic": np.array([day_night_heuristic(r) for r in rows]),
        "receiver track record (past reports only)": receiver_track_record(rows),
    }

    if args.predictions_out:
        with args.predictions_out.open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["utc", "mhz", "profile", "path_km", "heard", "reliability", "snr_db", "muf_mhz"])
            for r, a, b, c in zip(rows, rel, snr, muf):
                w.writerow([r.when, r.mhz, r.profile, r.path_km, int(r.heard), a, b, c])

    out = []
    p = out.append
    p(f"# DVOACAP vs VE3SUN reports (ssn scale {args.ssn_scale})\n")
    p(f"- rows scored: {ok.sum()} (dropped outside 2-30 MHz: {dropped}; "
      f"prediction failures: {dict(failures) or 0})")
    p(f"- heard rate: {heard[ok].mean():.3f}")
    p(f"- engine time: {elapsed:.1f} s total, {1000 * elapsed / max(1, len(rows)):.2f} ms per prediction\n")

    p("## Overall ROC AUC (95% bootstrap CI)\n")
    p("| score | AUC | CI |\n|---|---|---|")
    for name, s in scores.items():
        lo, hi = auc_ci(s[ok], heard[ok])
        p(f"| {name} | {fmt(auc(s[ok], heard[ok]))} | {fmt(lo)}-{fmt(hi)} |")

    for name in ("DVOACAP reliability", "DVOACAP SNR", "distance baseline (-path_km)"):
        p(f"\n## Heard rate by decile: {name}\n")
        p("| decile | score range | n | heard rate |\n|---|---|---|---|")
        for k, (lo, hi, n, hr) in enumerate(deciles(scores[name][ok], heard[ok]), 1):
            p(f"| {k} | {lo:.3g} .. {hi:.3g} | {n} | {hr:.3f} |")

    p("\n## By band\n")
    p("| MHz | n | heard rate | AUC reliability | AUC SNR | AUC MUF/f | AUC distance | AUC day/night |\n|---|---|---|---|---|---|---|---|")
    for lo, hi in BANDS:
        m = ok & (mhz >= lo) & (mhz < hi if hi < 30 else mhz <= hi)
        if m.sum() < 20:
            continue
        p(f"| {lo}-{hi} | {m.sum()} | {heard[m].mean():.3f} | "
          + " | ".join(fmt(auc(s[m], heard[m])) for s in scores.values()) + " |")

    p("\n## By path length (does the forecast add anything once distance is fixed?)\n")
    p("| km | n | heard rate | AUC reliability | AUC SNR | AUC MUF/f | AUC distance | AUC day/night |\n|---|---|---|---|---|---|---|---|")
    for lo, hi in DIST_BINS:
        m = ok & (dist >= lo) & (dist < hi)
        if m.sum() < 20:
            continue
        p(f"| {lo}-{hi} | {m.sum()} | {heard[m].mean():.3f} | "
          + " | ".join(fmt(auc(s[m], heard[m])) for s in scores.values()) + " |")

    p("\n## By mode profile\n")
    p("| profile | n | heard rate | AUC reliability | AUC SNR | AUC MUF/f | AUC distance | AUC day/night |\n|---|---|---|---|---|---|---|---|")
    prof = np.array([r.profile for r in rows])
    for name in MODE_PROFILES:
        m = ok & (prof == name)
        if m.sum() < 20:
            continue
        p(f"| {name} | {m.sum()} | {heard[m].mean():.3f} | "
          + " | ".join(fmt(auc(s[m], heard[m])) for s in scores.values()) + " |")

    # Ranking: same station, frequency, date and hour; receivers disagree.
    by_key: dict[tuple, list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        if ok[i]:
            by_key[(r.tx_key, round(r.mhz, 3), r.when.date(), r.when.hour)].append(i)
    groups = [np.array(g) for g in by_key.values() if 0 < heard[g].sum() < len(g)]
    p("\n## Ranking within a request (same station, frequency, UTC hour; mixed outcomes)\n")
    p(f"{len(groups)} groups, {sum(len(g) for g in groups)} reports.\n")
    p("| score | pairwise concordance | 95% CI (groups resampled) | pairs |\n|---|---|---|---|")
    rng = np.random.default_rng(61)
    boot_idx = [rng.integers(0, len(groups), len(groups)) for _ in range(500)]
    for name, s in scores.items():
        c, n = grouped_concordance(groups, s, heard)
        boots = sorted(grouped_concordance([groups[j] for j in b], s, heard)[0] for b in boot_idx)
        p(f"| {name} | {fmt(c)} | {fmt(boots[12])}-{fmt(boots[487])} | {n} |")

    print("\n".join(out))


# ---------------------------------------------------------------- timing

def bench_cmd(args: argparse.Namespace) -> None:
    rows, _ = load_rows(args.paths)
    rng = random.Random(61)
    receivers = list({r.rx for r in rows})
    stations = list({r.tx for r in rows})
    ssn = 100.0
    now = datetime.now(UTC)

    # Cold: fresh process state, first call loads the month's coefficients.
    t = time.perf_counter()
    engine = PredictionEngine()
    predict(engine, ssn, now.month, now.hour, stations[0], receivers[0], 14.1, "ssb")
    cold = time.perf_counter() - t

    single = []
    for _ in range(args.n):
        tx, rx = rng.choice(stations), rng.choice(receivers)
        t = time.perf_counter()
        predict(engine, ssn, now.month, now.hour, tx, rx, rng.uniform(2.5, 29.0), "ssb")
        single.append(time.perf_counter() - t)

    rank50 = []
    for _ in range(args.reps):
        tx, mhz = rng.choice(stations), rng.uniform(2.5, 29.0)
        rxs = rng.sample(receivers, 50)
        t = time.perf_counter()
        for rx in rxs:
            predict(engine, ssn, now.month, now.hour, tx, rx, mhz, "ssb")
        rank50.append(time.perf_counter() - t)

    # Changing month forces a coefficient reload: the worst case for a cache sweep.
    t = time.perf_counter()
    for m in range(1, 13):
        predict(engine, ssn, m, 12, stations[0], receivers[0], 14.1, "ssb")
    month_switch = (time.perf_counter() - t) / 12

    q = statistics.quantiles
    maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    maxrss_mb = maxrss / (1024 * 1024) if sys.platform == "darwin" else maxrss / 1024
    print(f"python {sys.version.split()[0]}, cpus visible {os.cpu_count()}")
    print(f"cold first prediction: {1000 * cold:.1f} ms")
    print(f"single prediction (n={args.n}): p50 {1000 * statistics.median(single):.2f} ms, "
          f"p95 {1000 * q(single, n=20)[18]:.2f} ms, max {1000 * max(single):.2f} ms")
    print(f"rank 50 receivers (reps={args.reps}): p50 {1000 * statistics.median(rank50):.0f} ms, "
          f"p95 {1000 * q(rank50, n=20)[18]:.0f} ms, max {1000 * max(rank50):.0f} ms")
    print(f"prediction after a month change: {1000 * month_switch:.1f} ms")
    print(f"peak RSS: {maxrss_mb:.0f} MB")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("score")
    s.add_argument("--paths", type=Path, required=True)
    s.add_argument("--ssn-scale", type=float, default=1.0)
    s.add_argument("--sample", type=int, default=0, help="score a random subset")
    s.add_argument("--predictions-out", type=Path, default=None,
                   help="per-row output; defaults to dvoacap-predictions.csv beside --paths")
    b = sub.add_parser("bench")
    b.add_argument("--paths", type=Path, required=True)
    b.add_argument("--n", type=int, default=2000)
    b.add_argument("--reps", type=int, default=50)
    args = ap.parse_args()
    if args.cmd == "score":
        if args.predictions_out is None:
            suffix = "" if args.ssn_scale == 1.0 else f"-ssn{args.ssn_scale:g}"
            args.predictions_out = args.paths.parent / f"dvoacap-predictions{suffix}.csv"
        score_cmd(args)
    else:
        bench_cmd(args)


if __name__ == "__main__":
    main()
