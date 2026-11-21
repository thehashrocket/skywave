"""#61 probe (eng review 2026-11-20, owner decision D4): could the replay score
broadcast answers at all? Each answer needs a WSPR spot with both ends close: the
sender near one of the broadcast's candidate transmitter sites, the receiver near
the Kiwi, on the WSPR band nearest the broadcast frequency, in the answer's spot
window. D4 builds the broadcast join only if at least 30% of the broadcast answers
with coordinates get such a match within 1,200 km; otherwise the number is written
up on #61 and the broadcast half stops. This script changes nothing; it only counts.

Window: the replay's (Step 1): it ends PICK_LEAD_S before the pick, and runs
--window-min minutes (a multiple of 3, one WSPR cycle being 2 min and one IBP cycle 3).
--window-min has no default: Step 1 hasn't frozen the length, and a longer window
only adds spots, so it can only raise the match share. Pass the length the replay
will use; the verdict holds for that length only, and says so.

Input: CSV from .local-data/61-step0.sql block 10:
    created_ms,picked_ms,freq_khz,kiwi_lat,kiwi_lon,outcome,tx_sites

    python broadcast_wspr_probe.py --answers ../../../../.local-data/61-broadcasts.csv \\
        --window-min <the replay's window> --expect-rows <block 10b's count>

wspr.live is asked once per UTC day and band (split into a few queries when one
URL would be too long; it refuses POST). Each answer is two columns of the reply:
the smallest "both ends" distance among that window's spots, and how many spots the
band had in the window anywhere, both computed on the server, so no spot rows come
back. Replies for windows that ended over a day ago are cached under
~/.cache/skywave-spike/. A reply that can't be had or trusted makes its answers
"unanswered", and then there is no verdict. An answer whose band had no spot at all
in its window (a wspr.live gap, or a band quiet worldwide) is counted apart and left
out of the share. Missing is never read as "no match".

Tests beside this file run by hand, not in CI: apps/radio/.venv/bin/pytest apps/radio/spikes/spots
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import http.client
import json
import math
import sys
import time
import urllib.parse
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from kiwi_grid_probe import CACHE_DIR, WSPR_LIVE, _at_least_1, _fetch, _save_cache

# wspr.live's `band` column and each band's WSPR dial frequency in MHz. Band 13
# (an experimental 22 m allocation) is left out: almost nobody transmits there.
WSPR_BANDS = {
    -1: 0.1375,
    0: 0.4742,
    1: 1.8366,
    3: 3.5686,
    5: 5.2872,
    7: 7.0386,
    10: 10.1387,
    14: 14.0956,
    18: 18.1046,
    21: 21.0946,
    24: 24.9246,
    28: 28.1246,
}
RADII_KM = (300, 600, 1200)
PASS_KM = 1200  # D4
PASS_SHARE = 0.30  # D4
PICK_LEAD_S = 40  # the replay's window ends this long before the pick (D6)
ANSWER_COLUMNS = ("created_ms", "picked_ms", "freq_khz", "kiwi_lat", "kiwi_lon", "outcome", "tx_sites")
OUTCOMES = ("heard", "not_heard", "no_open")  # apps/web/src/lib/reception.ts
# nginx in front of wspr.live allows about 8 KB of request line; stay well under.
MAX_URL = 7000
# wspr.live's tables fill in for a while after the fact; don't cache a reply for
# a window that ended less than this long ago.
CACHE_AFTER_S = 24 * 3600


@dataclass(frozen=True)
class Answer:
    line: int
    start_s: int  # window, UTC seconds
    end_s: int
    band: int
    kiwi: tuple[float, float]  # lat, lon
    sites: tuple[tuple[float, float], ...]
    outcome: str


def nearest_band(freq_khz: float) -> int:
    """The WSPR band nearest a frequency, by ratio (propagation scales with frequency,
    so 9.5 MHz is nearer 30 m than 40 m)."""
    mhz = freq_khz / 1000
    return min(WSPR_BANDS, key=lambda b: abs(math.log(mhz / WSPR_BANDS[b])))


def _position(lat: str, lon: str, what: str) -> tuple[float, float]:
    try:
        la, lo = float(lat), float(lon)
    except ValueError:
        raise ValueError(f"{what} isn't a position: {lat!r}, {lon!r}") from None
    if not (-90 <= la <= 90 and -180 <= lo <= 180):
        raise ValueError(f"{what} isn't a position: {lat!r}, {lon!r}")
    return la, lo


def parse_sites(raw: str) -> tuple[tuple[float, float], ...] | None:
    """The coordinates in a txSites value (#72): a JSON list of {key, coords: [[lat, lon], ...]}.
    None for an empty value (an answer from before #72, or a failed lookup). Raises
    ValueError for anything else, so a changed shape is never read as "no sites"."""
    if not raw.strip() or raw.strip() == "null":
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"tx_sites isn't JSON ({e.msg})") from None
    if not isinstance(data, list) or not all(isinstance(s, dict) and isinstance(s.get("coords"), list) for s in data):
        raise ValueError("tx_sites isn't a list of {key, coords}")
    out: set[tuple[float, float]] = set()
    for s in data:
        for c in s["coords"]:
            if not (isinstance(c, list) and len(c) == 2 and all(isinstance(v, (int, float)) for v in c)):
                raise ValueError(f"tx_sites has a coordinate that isn't [lat, lon]: {c!r}")
            out.add(_position(str(c[0]), str(c[1]), "a tx_sites coordinate"))
    return tuple(sorted(out))


def load_answers(path: Path, window_min: int) -> tuple[list[Answer], Counter]:
    """The broadcast answers the probe can score, and a count of the rest by reason
    (no Kiwi position, no sites, sites without coordinates, no_open). Raises
    ValueError naming the line for a row block 10 can't have produced, or no rows."""
    out: list[Answer] = []
    set_aside: Counter = Counter()
    rows_read = 0
    with path.open(newline="", encoding="utf-8-sig") as f:
        rows = csv.DictReader(f, strict=True)
        try:
            missing = [c for c in ANSWER_COLUMNS if c not in (rows.fieldnames or [])]
            if missing:
                raise ValueError(f"not block 10's export: no {', '.join(missing)} column")
            for row in rows:
                rows_read += 1
                line = rows.line_num
                if None in row or any(row.get(c) is None for c in ANSWER_COLUMNS):
                    raise ValueError(f"line {line}: not {len(ANSWER_COLUMNS)} fields")
                v = {c: row[c].strip() for c in ANSWER_COLUMNS}
                try:
                    a = _answer(line, v, window_min)
                except ValueError as e:
                    raise ValueError(f"line {line}: {e}") from None
                if isinstance(a, str):
                    set_aside[a] += 1
                else:
                    out.append(a)
        except csv.Error as e:  # an unclosed quote, say
            raise ValueError(f"line {rows.line_num}: {e}") from None
    if not rows_read:
        raise ValueError("no answer rows: an empty export")
    return out, set_aside


def _answer(line: int, v: dict[str, str], window_min: int) -> Answer | str:
    if v["outcome"] not in OUTCOMES:
        raise ValueError(f"outcome isn't one of {', '.join(OUTCOMES)}: {v['outcome']!r}")
    try:
        freq = float(v["freq_khz"])
    except ValueError:
        freq = -1
    if not 100 <= freq <= 30_000:
        raise ValueError(f"freq_khz isn't a shortwave or medium-wave frequency: {v['freq_khz']!r}")
    sites = parse_sites(v["tx_sites"])
    if (v["kiwi_lat"] == "") != (v["kiwi_lon"] == ""):
        raise ValueError("kiwi_lat and kiwi_lon aren't both set or both empty")
    if v["kiwi_lat"] and not v["picked_ms"].isdigit():
        raise ValueError(f"a Kiwi position without a whole picked_ms: {v['picked_ms']!r}")
    if not v["created_ms"].isdigit():
        raise ValueError(f"created_ms isn't a whole number: {v['created_ms']!r}")
    # Reasons the probe can't score a well-formed answer, in the order the replay drops them.
    if v["outcome"] == "no_open":
        return "no_open (the replay drops it)"
    if not v["kiwi_lat"]:
        return "no Kiwi position (no pick context)"
    if sites is None:
        return "no tx_sites (before #72, or the lookup failed)"
    if not sites:
        return "tx_sites without coordinates"
    kiwi = _position(v["kiwi_lat"], v["kiwi_lon"], "the Kiwi")
    end_s = int(v["picked_ms"]) // 1000 - PICK_LEAD_S
    return Answer(line, end_s - window_min * 60, end_s, nearest_band(freq), kiwi, sites, v["outcome"])


def _columns(a: Answer, i: int) -> str:
    """Answer i's two columns: a{i}, the smallest "both ends" distance in its window, and
    c{i}, how many spots the band had in that window anywhere (0: wspr.live has nothing)."""

    def d(lon_col: str, lat_col: str, p: tuple[float, float]) -> str:
        return f"greatCircleDistance({lon_col}, {lat_col}, {p[1]:.3f}, {p[0]:.3f})"

    tx = d("tx_lon", "tx_lat", a.sites[0]) if len(a.sites) == 1 else "least(" + ", ".join(d("tx_lon", "tx_lat", s) for s in a.sites) + ")"
    window = f"time >= toDateTime({a.start_s}) AND time < toDateTime({a.end_s})"
    # minOrNull: no spot in the window gives NULL, never min()'s 0 ("a perfect match").
    return f"minOrNullIf(greatest({tx}, {d('rx_lon', 'rx_lat', a.kiwi)}), {window}) AS a{i}, countIf({window}) AS c{i}"


def build_query(chunk: list[Answer]) -> str:
    band = chunk[0].band
    cols = ", ".join(_columns(a, i) for i, a in enumerate(chunk))
    start = min(a.start_s for a in chunk)
    end = max(a.end_s for a in chunk)
    return (
        f"SELECT {cols} FROM wspr.rx WHERE band = {band} "
        f"AND time >= toDateTime({start}) AND time < toDateTime({end}) FORMAT TabSeparatedWithNames"
    )


def query_url(query: str) -> str:
    # wait_end_of_query makes ClickHouse send an error as an HTTP error, not as a
    # line after the output it has already sent.
    return WSPR_LIVE + "?" + urllib.parse.urlencode({"query": query, "wait_end_of_query": 1})


def plan_queries(answers: list[Answer]) -> list[tuple[list[Answer], str]]:
    """One query per UTC day (of the window's end) and band, split when its URL would pass MAX_URL."""
    groups: dict[tuple[str, int], list[Answer]] = {}
    for a in sorted(answers, key=lambda a: (a.end_s, a.line)):
        day = datetime.fromtimestamp(a.end_s, timezone.utc).strftime("%Y-%m-%d")
        groups.setdefault((day, a.band), []).append(a)
    out: list[tuple[list[Answer], str]] = []
    for group in groups.values():
        chunk: list[Answer] = []
        for a in group:
            if chunk and len(query_url(build_query(chunk + [a]))) > MAX_URL:
                out.append((chunk, build_query(chunk)))
                chunk = []
            chunk.append(a)
            if len(query_url(build_query(chunk))) > MAX_URL:
                raise ValueError(f"line {a.line}: one answer's query is longer than {MAX_URL} characters ({len(a.sites)} sites)")
        out.append((chunk, build_query(chunk)))
    return out


Reply = list[tuple[float | None, int]]


def parse_reply(text: str, n: int) -> Reply | None:
    """Each answer's (distance in metres or None for no near spot, the band's spot count in
    its window), or None when the reply isn't exactly the header a0, c0, ..., a{n-1}, c{n-1}
    and one row: finite distances or NULLs, whole counts, and no distance without spots."""
    lines = text.splitlines()
    if len(lines) != 2 or lines[0].split("\t") != [c for i in range(n) for c in (f"a{i}", f"c{i}")]:
        return None
    values = lines[1].split("\t")
    if len(values) != 2 * n:
        return None
    out: Reply = []
    for v, c in zip(values[::2], values[1::2]):
        if not c.isdigit():
            return None
        if v == "\\N":
            out.append((None, int(c)))
            continue
        try:
            x = float(v)
        except ValueError:
            return None
        if not math.isfinite(x) or x < 0 or c == "0":
            return None
        out.append((x, int(c)))
    return out


def run_query(query: str, n: int, end_s: int, cache_dir: Path | None = None, now_s: float | None = None) -> Reply | None:
    """The reply, from the cache or wspr.live, or None when it can't be had or trusted."""
    cache_dir = CACHE_DIR if cache_dir is None else cache_dir  # read at call time, so tests can move it
    now_s = time.time() if now_s is None else now_s
    cache = cache_dir / f"wspr-broadcast-{hashlib.sha256(query.encode()).hexdigest()[:16]}.tsv"
    try:
        if cache.exists() and (cached := parse_reply(cache.read_text(encoding="utf-8"), n)) is not None:
            return cached
    except (OSError, ValueError):  # unreadable or not UTF-8: ask again
        pass
    try:
        text = _fetch(query_url(query))
    except (OSError, http.client.HTTPException, UnicodeDecodeError) as e:
        print(f"wspr.live: no reply ({e})", file=sys.stderr)
        return None
    got = parse_reply(text, n)
    if got is None:
        print(f"wspr.live: a reply that isn't {n} distances and counts ({text[:120]!r})", file=sys.stderr)
        return None
    if end_s < now_s - CACHE_AFTER_S:
        _save_cache(cache, text)
    return got


def summarize(answers: list[Answer], dist_m: dict[int, float | None], unanswered: set[int], quiet: set[int] = frozenset()) -> dict:
    """D4's shares and verdict. `quiet` answers (no spot on the band anywhere in the window:
    a wspr.live gap or a quiet band) are counted apart, never as unmatched."""
    scored = [a for a in answers if a.line not in unanswered and a.line not in quiet]
    near = {r: [a for a in scored if (d := dist_m.get(a.line)) is not None and d <= r * 1000] for r in RADII_KM}
    by_band: dict[int, list[int]] = {}
    for a in scored:
        hit = a in near[PASS_KM]
        by_band.setdefault(a.band, [0, 0])
        by_band[a.band][0] += hit
        by_band[a.band][1] += 1
    by_outcome = {o: [sum(1 for a in near[PASS_KM] if a.outcome == o), sum(1 for a in scored if a.outcome == o)] for o in ("heard", "not_heard")}
    share = len(near[PASS_KM]) / len(scored) if scored else None
    if not answers:
        verdict = "no verdict: no broadcast answers the probe can score"
    elif not unanswered and not scored:
        verdict = "no verdict: no answer's band had any WSPR spot in its window"
    elif unanswered:
        verdict = f"no verdict: {len(unanswered)} of {len(answers)} answers got no usable wspr.live reply (missing, not zero); run again"
    elif share >= PASS_SHARE:
        verdict = f"at least {PASS_SHARE:.0%} matched within {PASS_KM:,} km: build the broadcast join (D4)"
    else:
        verdict = f"under {PASS_SHARE:.0%} matched within {PASS_KM:,} km: write the number up on #61 and stop the broadcast half (D4)"
    return {
        "answers": len(answers),
        "scored": len(scored),
        "quiet": len(quiet),
        "near": {r: len(v) for r, v in near.items()},
        "share": share,
        "by_band": dict(sorted(by_band.items())),
        "by_outcome": by_outcome,
        "verdict": verdict,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--answers", type=Path, required=True)
    ap.add_argument("--window-min", type=_at_least_1, required=True, help="spot window length, minutes (a multiple of 3): the length the replay will freeze, since a longer one only raises the share")
    ap.add_argument("--expect-rows", type=_at_least_1, help="block 10b's count: refuse an export with any other number of rows")
    args = ap.parse_args(argv)
    if args.window_min % 3:
        ap.error(f"--window-min must be a multiple of 3 (the replay's rule), not {args.window_min}")

    try:
        answers, set_aside = load_answers(args.answers, args.window_min)
        rows = len(answers) + sum(set_aside.values())
        if args.expect_rows is not None and rows != args.expect_rows:
            raise ValueError(f"{rows} rows, but block 10b counted {args.expect_rows}: a capped or partial download?")
        queries = plan_queries(answers)
    except (OSError, ValueError) as e:  # UnicodeDecodeError included
        print(f"--answers {args.answers}: {e}", file=sys.stderr)
        return 2

    dist_m: dict[int, float | None] = {}
    unanswered: set[int] = set()
    quiet: set[int] = set()
    for chunk, query in queries:
        got = run_query(query, len(chunk), max(a.end_s for a in chunk))
        if got is None:
            unanswered.update(a.line for a in chunk)
        else:
            for a, (d, spots) in zip(chunk, got):
                dist_m[a.line] = d
                if spots == 0:
                    quiet.add(a.line)
    s = summarize(answers, dist_m, unanswered, quiet)

    print(f"answer rows read: {rows}; probed: {s['answers']} in {len(queries)} wspr.live queries; window {args.window_min} min")
    for reason, n in sorted(set_aside.items()):
        print(f"  set aside: {n} {reason}")
    if unanswered:
        print(f"  unanswered: {len(unanswered)} (wspr.live missing; not counted as unmatched)")
    if quiet:
        print(f"  no WSPR spot on the band anywhere in the window: {len(quiet)} (a wspr.live gap or a quiet band; not counted as unmatched)")
    pct = lambda n, d: f"{100 * n / d:.1f}%" if d else "n/a"
    for r in RADII_KM:
        print(f"both ends within {r:>5,} km: {s['near'][r]:>5} of {s['scored']} ({pct(s['near'][r], s['scored'])})")
    for o, (hit, n) in s["by_outcome"].items():
        print(f"  {o:<9} within {PASS_KM:,} km: {hit} of {n} ({pct(hit, n)})")
    for band, (hit, n) in s["by_band"].items():
        print(f"  band {band:>3} ({WSPR_BANDS[band]:g} MHz): {hit} of {n} ({pct(hit, n)})")
    print(f"{s['verdict']} [for a {args.window_min}-min window only]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
