"""#61 probe (eng review 2026-11-20, owner decision D12): how many of the Kiwis
listeners answered about share a 6-character Maidenhead grid with an RBN skimmer
or a WSPR reporter, i.e. are probably reporting spots themselves.

The Kiwi list gives a position, not a callsign, so a grid match is the only
join. A 6-character square is about 5 x 2.5 km. The count goes to the Step 1
freeze, where the owner decides whether the replay gets a second spot score
from the Kiwi's own reports. This script changes nothing; it only counts.

Inputs:
  --receivers  CSV from .local-data/61-step0.sql block 9: receiver,lat,lon,answers
  --skimmers   JSON list of skimmers with "call" and "grid": either RBN's
               detail list (.local-data/rbn-skimmers/*-detail.json) or the
               `skimmers` column of an RbnSkimmerDay row
  wspr.live    distinct receiver grids over the last --wspr-days days, fetched
               once and cached under ~/.cache/skywave-spike/ (skip with --no-wspr)

    python kiwi_grid_probe.py --receivers ../../../../.local-data/61-receivers.csv \\
        --skimmers ../../../../.local-data/rbn-skimmers/2026-11-19-detail.json

"answers" are answers with pick context (block 9 counts only those). The tests
beside this file are a spike's and run by hand, not in CI (pytest's testpaths
is apps/radio/tests): apps/radio/.venv/bin/pytest apps/radio/spikes/spots
"""

from __future__ import annotations

import argparse
import csv
import http.client
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

WSPR_LIVE = "https://db1.wspr.live/"
CACHE_DIR = Path.home() / ".cache" / "skywave-spike"
FETCH_TIMEOUT_S = 60
# More rows than this and the reply may have been cut at the query's LIMIT.
WSPR_ROW_LIMIT = 200_000
# The same floor as RBN_MIN_SKIMMERS in apps/web/src/lib/rbn.ts, counted the same
# way (skimmers with a usable grid, before co-located ones collapse to one square):
# fewer means the wrong file or shape, not a quiet day.
MIN_SKIMMERS = 100
RECEIVER_COLUMNS = ("receiver", "lat", "lon", "answers")
# The same locator rule as maidenhead() in apps/web/src/lib/rbn.ts: 4, 6 or 8
# characters, field letters A-R, subsquare letters A-X. Only 6 and 8 can match.
LOCATOR = re.compile(r"[A-R]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)?")


@dataclass(frozen=True)
class Receiver:
    key: str
    grid: str
    answers: int


def grid6(lat: float, lon: float) -> str:
    """The 6-character Maidenhead square for a position, upper-cased."""
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError(f"not a position: {lat}, {lon}")
    # The north pole and the antimeridian belong to the last square, not one past it.
    x = min(lon + 180, 359.999999)
    y = min(lat + 90, 179.999999)
    return (
        chr(ord("A") + int(x // 20))
        + chr(ord("A") + int(y // 10))
        + str(int((x % 20) // 2))
        + str(int(y % 10))
        + chr(ord("A") + int((x % 2) * 12))
        + chr(ord("A") + int((y % 1) * 24))
    )


def load_receivers(path: Path) -> tuple[list[Receiver], int]:
    """The CSV's receivers with a usable position, and how many rows were skipped.
    Raises ValueError when the header lacks a column, so a wrong file isn't read as
    every row skipped."""
    out: list[Receiver] = []
    skipped = 0
    with path.open(newline="") as f:
        rows = csv.DictReader(f)
        missing = [c for c in RECEIVER_COLUMNS if c not in (rows.fieldnames or [])]
        if missing:
            raise ValueError(f"not block 9's export: no {', '.join(missing)} column")
        for row in rows:
            try:
                out.append(Receiver(row["receiver"], grid6(float(row["lat"]), float(row["lon"])), int(row["answers"])))
            except (KeyError, TypeError, ValueError):
                skipped += 1
    return out, skipped


def six(raw: object) -> str | None:
    """A locator's 6-character square, upper-cased, or None for a 4-character or malformed one."""
    g = str(raw or "").strip().upper()
    return g[:6] if len(g) in (6, 8) and LOCATOR.fullmatch(g) else None


def skimmer_grids(path: Path) -> set[str]:
    """6-character grids of the skimmers in RBN's detail list or one RbnSkimmerDay row
    (as exported: a row, a list holding one row, or its `skimmers` column). Shorter or
    malformed grids are left out. Raises ValueError for any other shape, several days'
    rows, or fewer than MIN_SKIMMERS skimmers with a usable grid, so a wrong file is
    never read as zero matches."""
    data = json.loads(path.read_text())
    if isinstance(data, list) and data and all(isinstance(x, dict) and "skimmers" in x for x in data):
        if len(data) != 1:
            raise ValueError(f"{len(data)} RbnSkimmerDay rows: export one day")
        data = data[0]
    if isinstance(data, dict):
        if "skimmers" not in data:
            raise ValueError("not a skimmer list: an object without 'skimmers'")
        data = data["skimmers"]
        if isinstance(data, str):  # a Json column exported as text
            data = json.loads(data)
    if not isinstance(data, list):
        raise ValueError("not a skimmer list")
    placed = [g for s in data if isinstance(s, dict) and (g := six(s.get("grid")))]
    if len(placed) < MIN_SKIMMERS:
        raise ValueError(f"only {len(placed)} skimmers with a usable grid (fewer than {MIN_SKIMMERS}): wrong file?")
    return set(placed)


def parse_wspr_grids(text: str) -> set[str]:
    """6-character grids from wspr.live's TabSeparated reply, one rx_loc per line."""
    return {g for line in text.splitlines() if (g := six(line))}


def wspr_grids(days: int, cache_dir: Path = CACHE_DIR) -> set[str] | None:
    """Distinct WSPR receiver grids over the last `days` days, or None when wspr.live
    can't be reached or sends nothing, an error or a possibly cut reply: a missing
    source, never an empty or partial one."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    cache = cache_dir / f"wspr-rx-grids-{days}d-{today}.tsv"
    try:
        cached = parse_wspr_grids(cache.read_text()) if cache.exists() else set()
    except (OSError, ValueError):  # unreadable or not UTF-8: fetch again
        cached = set()
    if cached:
        return cached  # an empty or unreadable cache (an interrupted write) falls through to a fetch
    query = (
        "SELECT DISTINCT rx_loc FROM wspr.rx "
        f"WHERE time > now() - INTERVAL {days} DAY AND length(rx_loc) >= 6 "
        f"LIMIT {WSPR_ROW_LIMIT} FORMAT TabSeparated"
    )
    # wait_end_of_query makes ClickHouse send an error as an HTTP error, not as a
    # line after rows it has already streamed.
    url = WSPR_LIVE + "?" + urllib.parse.urlencode({"query": query, "wait_end_of_query": 1})
    try:
        text = _fetch(url)
    except (OSError, http.client.HTTPException, UnicodeDecodeError) as e:  # URLError, timeouts, a cut-off or garbled read
        print(f"wspr.live: source missing ({e})", file=sys.stderr)
        return None
    lines = text.splitlines()
    if any("Exception" in line for line in lines):
        print("wspr.live: source missing (the reply ends in an error)", file=sys.stderr)
        return None
    if len(lines) >= WSPR_ROW_LIMIT:
        print(f"wspr.live: source missing (the reply hit the {WSPR_ROW_LIMIT}-row limit)", file=sys.stderr)
        return None
    grids = parse_wspr_grids(text)
    if not grids:
        print("wspr.live: source missing (no grids in the reply)", file=sys.stderr)
        return None
    _save_cache(cache, text)
    return grids


def _save_cache(cache: Path, text: str) -> None:
    """Best-effort: a cache that can't be written costs a refetch, never the run.
    A per-run temp file, fsynced and renamed, so the day's name never holds a
    half-written or interleaved file."""
    tmp = None
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", dir=cache.parent, prefix=cache.name + ".", suffix=".tmp", delete=False) as f:
            tmp = f.name
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, cache)
    except OSError as e:
        print(f"wspr.live: cache not saved ({e})", file=sys.stderr)
        if tmp:
            Path(tmp).unlink(missing_ok=True)


def _fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "skywave-spike/61"})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as r:
        return r.read().decode()


def summarize(receivers: list[Receiver], rbn: set[str], wspr: set[str] | None) -> dict:
    """Matches by receiver and weighted by answers, for each source and either."""

    def share(match) -> dict:
        hit = [r for r in receivers if match(r)]
        return {
            "receivers": len(hit),
            "answers": sum(r.answers for r in hit),
        }

    total = {"receivers": len(receivers), "answers": sum(r.answers for r in receivers)}
    out = {"total": total, "rbn": share(lambda r: r.grid in rbn)}
    if wspr is None:
        out["wspr"] = None
        out["either"] = None
    else:
        out["wspr"] = share(lambda r: r.grid in wspr)
        out["either"] = share(lambda r: r.grid in rbn or r.grid in wspr)
    return out


def _line(label: str, part: dict | None, total: dict, absent: str) -> str:
    if part is None:
        return f"{label:<8} {absent}"
    pct = lambda n, d: f"{100 * n / d:.1f}%" if d else "n/a"
    return (
        f"{label:<8} {part['receivers']:>5} of {total['receivers']} receivers ({pct(part['receivers'], total['receivers'])}), "
        f"{part['answers']:>6} of {total['answers']} answers ({pct(part['answers'], total['answers'])})"
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--receivers", type=Path, required=True)
    ap.add_argument("--skimmers", type=Path, required=True)
    ap.add_argument("--wspr-days", type=int, default=7)
    ap.add_argument("--no-wspr", action="store_true", help="count RBN skimmers only")
    ap.add_argument("--list", action="store_true", help="also print each matched receiver")
    args = ap.parse_args(argv)

    try:
        receivers, skipped = load_receivers(args.receivers)
    except (OSError, ValueError) as e:
        print(f"--receivers {args.receivers}: {e}", file=sys.stderr)
        return 2
    try:
        rbn = skimmer_grids(args.skimmers)
    except (OSError, ValueError) as e:  # a missing file, json.JSONDecodeError included
        print(f"--skimmers {args.skimmers}: {e}", file=sys.stderr)
        return 2
    wspr = None if args.no_wspr else wspr_grids(args.wspr_days)
    s = summarize(receivers, rbn, wspr)

    print(f"skimmer grids: {len(rbn)}; wspr reporter grids: {'skipped' if args.no_wspr else len(wspr) if wspr is not None else 'missing'}")
    if skipped:
        print(f"skipped {skipped} receiver rows without a usable position")
    absent = "skipped (--no-wspr)" if args.no_wspr else "wspr.live source missing"
    for label in ("rbn", "wspr", "either"):
        print(_line(label, s[label], s["total"], absent))
    if args.list:
        for r in receivers:
            src = [n for n, g in (("rbn", rbn), ("wspr", wspr or set())) if r.grid in g]
            if src:
                print(f"  {r.key} {r.grid} {'+'.join(src)} ({r.answers} answers)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
