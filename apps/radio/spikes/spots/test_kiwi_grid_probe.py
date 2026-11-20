"""Tests for the #61 D12 Kiwi-own grid probe. Run from the repo root:

    apps/radio/.venv/bin/pytest apps/radio/spikes/spots
"""

import http.client
import json
import subprocess
import sys
from pathlib import Path

import pytest

import kiwi_grid_probe
from kiwi_grid_probe import Receiver, grid6, load_receivers, skimmer_grids, summarize, wspr_grids

# skimmer_grids refuses fewer than MIN_SKIMMER_GRIDS usable grids, so every skimmer
# fixture carries these 100 (AA00AA..AA99AA), which no test receiver sits on.
FILLER = [{"call": f"F{i}", "grid": f"AA{i:02d}AA"} for i in range(100)]
FILLER_GRIDS = {r["grid"] for r in FILLER}


# Value: protects=a Kiwi's position becomes the right 6-character square; fails_when=field, square or subsquare math is off by one or axes swap; why_new=no Python grid code exists; seam=none; no_claim=accuracy of the Kiwi list's own positions
@pytest.mark.parametrize(
    ("lat", "lon", "grid"),
    [
        (41.714775, -72.727260, "FN31PR"),  # W1AW, Newington CT
        (51.5074, -0.1278, "IO91WM"),  # London
        (-33.8688, 151.2093, "QF56OD"),  # Sydney
        (90, 180, "RR99XX"),  # pole and antimeridian stay in the last square
        (-90, -180, "AA00AA"),
    ],
)
def test_grid6(lat, lon, grid):
    assert grid6(lat, lon) == grid


# Value: protects=an impossible position is refused, not wrapped into a real square; fails_when=the range check is dropped; why_new=new function; seam=none; no_claim=none beyond protects
def test_grid6_rejects_non_positions():
    with pytest.raises(ValueError):
        grid6(91, 0)


# Value: protects=only valid 6/8-character locators (rbn.ts's rule) can match, from either export shape; fails_when=a 4-character, out-of-range or junk grid is kept, or the RbnSkimmerDay shape is ignored; why_new=new loader; seam=none; no_claim=grids RBN operators typed wrong
def test_skimmer_grids_keeps_six_character_grids_from_both_shapes(tmp_path):
    rows = [{"call": "A", "grid": "fn31pr"}, {"call": "B", "grid": "FN31"}, {"call": "C", "grid": None}, {"call": "D", "grid": "12ab34"}, {"call": "E", "grid": "ZZ00ZZ"}, {"call": "F", "grid": "IO91WM12"}, {"call": "G", "grid": "IO91WMX"}]
    listed = tmp_path / "detail.json"
    listed.write_text(json.dumps(rows + FILLER))
    day = tmp_path / "day.json"
    day.write_text(json.dumps({"skimmers": rows + FILLER}))
    assert skimmer_grids(listed) - FILLER_GRIDS == {"FN31PR", "IO91WM"}
    assert skimmer_grids(day) - FILLER_GRIDS == {"FN31PR", "IO91WM"}


# Value: protects=rows without a usable position are counted as skipped, not dropped silently or crashing; fails_when=a blank lat raises or vanishes uncounted; why_new=new loader; seam=none; no_claim=none beyond protects
def test_load_receivers_skips_rows_without_a_position(tmp_path):
    p = tmp_path / "r.csv"
    p.write_text("receiver,lat,lon,answers\nk1:8073,41.714775,-72.72726,5\nk2:8073,,,3\nk3:8073,95,0,1\n")
    receivers, skipped = load_receivers(p)
    assert receivers == [Receiver("k1:8073", "FN31PR", 5)]
    assert skipped == 2


# Value: protects=match shares by receiver and by answers, and "either" never double counts; fails_when=a Kiwi matched by both sources counts twice or answers aren't weighted; why_new=new summary; seam=none; no_claim=that a grid match means the Kiwi itself reports
def test_summarize_counts_receivers_and_answers():
    rs = [Receiver("a", "FN31PR", 10), Receiver("b", "IO91WM", 3), Receiver("c", "QF56OD", 1)]
    s = summarize(rs, rbn={"FN31PR"}, wspr={"FN31PR", "IO91WM"})
    assert s["total"] == {"receivers": 3, "answers": 14}
    assert s["rbn"] == {"receivers": 1, "answers": 10}
    assert s["wspr"] == {"receivers": 2, "answers": 13}
    assert s["either"] == {"receivers": 2, "answers": 13}


# Value: protects=an unreachable wspr.live reads as "source missing", never as zero matches; fails_when=the error is swallowed into an empty set; why_new=new client; seam=none (monkeypatches the module's HTTP call); no_claim=wspr.live's query syntax (not called)
def test_wspr_unreachable_is_missing_not_empty(tmp_path, monkeypatch):
    def down(url):
        raise OSError("connection refused")

    monkeypatch.setattr(kiwi_grid_probe, "_fetch", down)
    assert wspr_grids(7, cache_dir=tmp_path) is None
    assert not list(tmp_path.iterdir())  # nothing cached for a failed fetch
    s = summarize([Receiver("a", "FN31PR", 1)], rbn=set(), wspr=None)
    assert s["wspr"] is None and s["either"] is None


# Value: protects=wspr.live is asked once per day and short grids are ignored; fails_when=cache is skipped or 4-character grids match; why_new=new client; seam=none (monkeypatches the module's HTTP call); no_claim=wspr.live's live reply format
def test_wspr_reply_is_cached_and_parsed(tmp_path, monkeypatch):
    calls = []

    def reply(url):
        calls.append(url)
        return "fn31pr\nIO91WM\nFN31\n"

    monkeypatch.setattr(kiwi_grid_probe, "_fetch", reply)
    assert wspr_grids(7, cache_dir=tmp_path) == {"FN31PR", "IO91WM"}
    assert wspr_grids(7, cache_dir=tmp_path) == {"FN31PR", "IO91WM"}
    assert len(calls) == 1


# Value: protects=an empty or cut-off wspr.live reply reads as "source missing" and isn't cached as a zero for the day; fails_when=an empty 200 body becomes an empty set; why_new=review finding on the missing-vs-zero rule; seam=none (monkeypatches the module's HTTP call); no_claim=which HTTP failures wspr.live actually produces
@pytest.mark.parametrize("reply", ["", "FN31\n", http.client.IncompleteRead(b"")])
def test_wspr_empty_or_cut_off_reply_is_missing(tmp_path, monkeypatch, reply):
    def fetch(url):
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(kiwi_grid_probe, "_fetch", fetch)
    assert wspr_grids(7, cache_dir=tmp_path) is None
    assert not list(tmp_path.iterdir())


REPO = Path(__file__).resolve().parents[4]
PROBE = "apps/radio/spikes/spots/kiwi_grid_probe.py"


# Value: protects=the script runs as the owner will run it (CSV + skimmer JSON in, counts out) and says "skipped" for --no-wspr; fails_when=argparse wiring, output or the skipped/missing label breaks; why_new=main() had no test; seam=none; no_claim=wspr.live (skipped)
def test_cli_counts_matches_and_marks_wspr_skipped(tmp_path):
    receivers = tmp_path / "receivers.csv"
    receivers.write_text("receiver,lat,lon,answers\nk1:8073,41.714775,-72.72726,5\nk2:8073,51.5074,-0.1278,3\n")
    skimmers = tmp_path / "skimmers.json"
    skimmers.write_text(json.dumps([{"call": "W1AW", "grid": "FN31PR"}] + FILLER))
    out = subprocess.run(
        [sys.executable, PROBE, "--receivers", str(receivers), "--skimmers", str(skimmers), "--no-wspr", "--list"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout
    assert "rbn          1 of 2 receivers (50.0%),      5 of 8 answers (62.5%)" in out
    assert "wspr     skipped (--no-wspr)" in out
    assert "k1:8073 FN31PR rbn (5 answers)" in out


# Value: protects=a CSV with the wrong columns or a short row is counted as skipped, not a crash; fails_when=KeyError or TypeError escapes load_receivers; why_new=only blank/out-of-range rows were tested; seam=none; no_claim=other export shapes
@pytest.mark.parametrize(
    "text",
    [
        "rx,lat,lon,answers\nk1:8073,41.714775,-72.72726,5\n",  # wrong header -> KeyError
        "receiver,lat,lon,answers\nk1:8073,41.714775\n",  # short row -> None fields, TypeError
    ],
)
def test_load_receivers_skips_malformed_rows(tmp_path, text):
    p = tmp_path / "r.csv"
    p.write_text(text)
    assert load_receivers(p) == ([], 1)


def _inputs(tmp_path, csv_text):
    receivers = tmp_path / "receivers.csv"
    receivers.write_text(csv_text)
    skimmers = tmp_path / "skimmers.json"
    skimmers.write_text(json.dumps([{"call": "W1AW", "grid": "FN31PR"}] + FILLER))
    return ["--receivers", str(receivers), "--skimmers", str(skimmers)]


# Value: protects=main() prints "missing" for wspr and either when wspr.live is down, never a 0 count; fails_when=None becomes an empty set or the missing label is lost; why_new=main's missing path had no test; seam=none (monkeypatches wspr_grids); no_claim=wspr.live itself
def test_main_marks_wspr_missing_not_zero(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(kiwi_grid_probe, "wspr_grids", lambda days, cache_dir=None: None)
    assert kiwi_grid_probe.main(_inputs(tmp_path, "receiver,lat,lon,answers\nk1:8073,41.714775,-72.72726,5\n")) == 0
    lines = capsys.readouterr().out.splitlines()
    assert "skimmer grids: 101; wspr reporter grids: missing" in lines
    assert "wspr     wspr.live source missing" in lines  # whole line: no count beside it
    assert "either   wspr.live source missing" in lines


# Value: protects=main() counts wspr and either from wspr.live grids, lists rbn+wspr for a Kiwi both match, and reports skipped rows; fails_when=wspr is ignored, either double counts, or the skip line is lost; why_new=main's wspr path had no test; seam=none (monkeypatches wspr_grids); no_claim=wspr.live itself
def test_main_counts_wspr_and_lists_both_sources(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(kiwi_grid_probe, "wspr_grids", lambda days, cache_dir=None: {"IO91WM", "FN31PR"})
    csv_text = (
        "receiver,lat,lon,answers\n"
        "k1:8073,41.714775,-72.72726,5\n"  # FN31PR: rbn and wspr
        "k2:8073,51.5074,-0.1278,3\n"  # IO91WM: wspr only
        "k3:8073,-33.8688,151.2093,1\n"  # QF56OD: neither
        "k4:8073,,,7\n"  # no position
    )
    assert kiwi_grid_probe.main(_inputs(tmp_path, csv_text) + ["--list"]) == 0
    out = capsys.readouterr().out
    assert "skimmer grids: 101; wspr reporter grids: 2" in out
    assert "skipped 1 receiver rows without a usable position" in out
    assert "rbn          1 of 3 receivers (33.3%),      5 of 9 answers (55.6%)" in out
    assert "wspr         2 of 3 receivers (66.7%),      8 of 9 answers (88.9%)" in out
    assert "either       2 of 3 receivers (66.7%),      8 of 9 answers (88.9%)" in out
    assert "k1:8073 FN31PR rbn+wspr (5 answers)" in out
    assert "k2:8073 IO91WM wspr (3 answers)" in out
    assert "k3:8073" not in out


# Value: protects=a header-only CSV prints n/a shares instead of dividing by zero; fails_when=the zero-total guard in _line is dropped; why_new=no empty-input test; seam=none; no_claim=wspr.live (skipped)
def test_main_empty_csv_prints_na(tmp_path, capsys):
    assert kiwi_grid_probe.main(_inputs(tmp_path, "receiver,lat,lon,answers\n") + ["--no-wspr"]) == 0
    out = capsys.readouterr().out
    assert "rbn          0 of 0 receivers (n/a),      0 of 0 answers (n/a)" in out
    assert "wspr     skipped (--no-wspr)" in out


# Value: protects=one RbnSkimmerDay row is read in any export shape, and a wrong shape, several days or too few grids is refused, never read as 0 RBN matches; fails_when=a shape check or the 100-grid floor is dropped; why_new=review finding (red-team #2); seam=none; no_claim=Neon's exact export format
@pytest.mark.parametrize(
    ("data", "ok"),
    [
        ([{"day": "2026-11-26", "skimmers": [{"call": "W1AW", "grid": "FN31PR"}] + FILLER}], True),
        ({"day": "2026-11-26", "skimmers": json.dumps([{"call": "W1AW", "grid": "FN31PR"}] + FILLER)}, True),
        ([{"day": "2026-11-25", "skimmers": FILLER}, {"day": "2026-11-26", "skimmers": FILLER}], False),
        ({"day": "2026-11-26"}, False),
        ([{"call": "W1AW", "grid": None}] * 200, False),
        (FILLER[:99], False),
        ("FN31PR", False),
    ],
)
def test_skimmer_grids_accepts_one_day_and_refuses_the_rest(tmp_path, data, ok):
    p = tmp_path / "s.json"
    p.write_text(json.dumps(data))
    if ok:
        assert "FN31PR" in skimmer_grids(p)
    else:
        with pytest.raises(ValueError):
            skimmer_grids(p)


# Value: protects=a refused skimmer file stops the CLI with exit 2 and a reason, printing no counts; fails_when=main swallows the error or prints rbn 0 of N; why_new=review finding (red-team #2); seam=none; no_claim=none beyond protects
def test_main_refuses_a_wrong_skimmer_file(tmp_path, capsys):
    receivers = tmp_path / "r.csv"
    receivers.write_text("receiver,lat,lon,answers\nk1:8073,41.714775,-72.72726,5\n")
    skimmers = tmp_path / "s.json"
    skimmers.write_text(json.dumps({"day": "2026-11-26"}))
    assert kiwi_grid_probe.main(["--receivers", str(receivers), "--skimmers", str(skimmers), "--no-wspr"]) == 2
    out = capsys.readouterr()
    assert out.out == "" and "without 'skimmers'" in out.err


# Value: protects=an empty or half-written cache is never read as zero: it falls through to a fetch, and a failed fetch reads as missing; fails_when=the cache hit skips the empty check; why_new=review finding (red-team #1, QA probe 002); seam=none (monkeypatches the module's HTTP call); no_claim=crash timing
def test_empty_cache_falls_through_to_fetch(tmp_path, monkeypatch):
    from datetime import datetime, timezone

    cache = tmp_path / f"wspr-rx-grids-7d-{datetime.now(timezone.utc):%Y-%m-%d}.tsv"
    cache.write_text("")

    def down(url):
        raise OSError("down")

    monkeypatch.setattr(kiwi_grid_probe, "_fetch", down)
    assert wspr_grids(7, cache_dir=tmp_path) is None
    monkeypatch.setattr(kiwi_grid_probe, "_fetch", lambda url: "FN31PR\n")
    assert wspr_grids(7, cache_dir=tmp_path) == {"FN31PR"}
    assert cache.read_text() == "FN31PR\n"
    assert [p.name for p in tmp_path.iterdir()] == [cache.name]  # no .tmp left behind


# Value: protects=a garbled, error-tailed or row-limit-cut wspr.live reply reads as missing and is not cached; fails_when=UnicodeDecodeError escapes, an Exception line is dropped silently, or a full-limit reply is trusted; why_new=review findings (core, red-team #3); seam=none (monkeypatches _fetch and the limit); no_claim=ClickHouse's exact error text
@pytest.mark.parametrize(
    "reply",
    [
        UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte"),
        "FN31PR\nIO91WM\nCode: 159. DB::Exception: Timeout exceeded\n",
        "FN31PR\nIO91WM\nFN31PQ\n",
    ],
)
def test_wspr_garbled_error_or_cut_reply_is_missing(tmp_path, monkeypatch, reply):
    def fetch(url):
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(kiwi_grid_probe, "_fetch", fetch)
    monkeypatch.setattr(kiwi_grid_probe, "WSPR_ROW_LIMIT", 3)
    assert wspr_grids(7, cache_dir=tmp_path) is None
    assert not list(tmp_path.iterdir())
