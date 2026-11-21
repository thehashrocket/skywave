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
from kiwi_grid_probe import Receiver, grid6, load_receivers, skimmer_grids, summarize, wspr_cache_path, wspr_grids

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


# Value: protects=block 9's rows load as receivers, a byte-order mark and spaces around values are ignored; fails_when=the BOM hides the receiver column or padded values are refused; why_new=PR #85 review note (BOM); seam=none; no_claim=Neon's exact CSV dialect
def test_load_receivers_reads_block_9(tmp_path):
    p = tmp_path / "r.csv"
    p.write_text("\ufeffreceiver,lat,lon,answers\nk1:8073, 41.714775 ,-72.72726,5\nk2:8073,51.5074,-0.1278,3\n", encoding="utf-8")
    assert load_receivers(p) == [Receiver("k1:8073", "FN31PR", 5), Receiver("k2:8073", "IO91WM", 3)]


GOOD_ROW = "k1:8073,41.714775,-72.72726,5\n"


# Value: protects=any receiver row block 9 can't have produced (no position, bad position, a bad or non-positive count, short or long, merged by a stray quote, an unclosed quote, a repeated receiver) or an export with no rows stops the load with the line, never shrinking the count; fails_when=a bad row is skipped or crashes with another error, so the probe reports a smaller share; why_new=TODOS "Harden the #61 grid probe's input checks"; seam=none; no_claim=a well-formed export of the wrong query
@pytest.mark.parametrize(
    ("rows", "reason"),
    [
        ("k2:8073,,,3\n", "not a position"),
        ("k2:8073,95,0,1\n", "not a position"),
        ("k2:8073,41,-72,many\n", "answers isn't a whole number"),
        ("k2:8073,41,-72,-2\n", "answers isn't a whole number"),
        ("k2:8073,41,-72,0\n", "answers isn't a whole number"),
        ("k2:8073,41,-72,2.5\n", "answers isn't a whole number"),
        ("k2:8073,41.714775\n", "not 4 fields"),
        ("k2:8073,41,-72,3,extra\n", "not 4 fields"),
        ('k2:8073,"41,-72,3\nk3:8073,51,0,2\n', "unexpected end of data"),
        ('"k2:8073,41,-72,3\nk3:8073",51,0,2\n', "spans lines"),
        (GOOD_ROW, "repeated"),
        (",41,-72,3\n", "blank or repeated"),
    ],
)
def test_load_receivers_refuses_rows_block_9_cant_produce(tmp_path, rows, reason):
    p = tmp_path / "r.csv"
    p.write_text("receiver,lat,lon,answers\n" + GOOD_ROW + rows)
    with pytest.raises(ValueError, match=reason):
        load_receivers(p)


# Value: protects=an export with no rows (header only, or 0 bytes) is refused, not printed as 0 of 0; fails_when=an empty download reads as "no matches"; why_new=TODOS hardening item, PR #85 coverage gap (0-byte CSV); seam=none; no_claim=none beyond protects
@pytest.mark.parametrize("text", ["receiver,lat,lon,answers\n", ""])
def test_load_receivers_refuses_an_empty_export(tmp_path, text):
    p = tmp_path / "r.csv"
    p.write_text(text)
    with pytest.raises(ValueError, match="no receiver rows|no receiver, lat"):
        load_receivers(p)


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


# Value: protects=a CSV without block 9's columns is refused (exit 2), not read as 0 of 0; fails_when=the header check is dropped; why_new=Step 11 structured review (P3); seam=none; no_claim=none beyond protects
def test_main_refuses_a_csv_without_the_columns(tmp_path, capsys):
    receivers = tmp_path / "r.csv"
    receivers.write_text("rx,lat,lon,answers\nk1:8073,41.714775,-72.72726,5\n")
    skimmers = tmp_path / "s.json"
    skimmers.write_text(json.dumps(FILLER))
    assert kiwi_grid_probe.main(["--receivers", str(receivers), "--skimmers", str(skimmers), "--no-wspr"]) == 2
    out = capsys.readouterr()
    assert out.out == "" and "no receiver column" in out.err


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


# Value: protects=main() counts wspr and either from wspr.live grids, lists rbn+wspr for a Kiwi both match, and prints how many rows it read; fails_when=wspr is ignored, either double counts, or the row count is lost; why_new=main's wspr path had no test; seam=none (monkeypatches wspr_grids); no_claim=wspr.live itself
def test_main_counts_wspr_and_lists_both_sources(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(kiwi_grid_probe, "wspr_grids", lambda days, cache_dir=None: {"IO91WM", "FN31PR"})
    csv_text = (
        "receiver,lat,lon,answers\n"
        "k1:8073,41.714775,-72.72726,5\n"  # FN31PR: rbn and wspr
        "k2:8073,51.5074,-0.1278,3\n"  # IO91WM: wspr only
        "k3:8073,-33.8688,151.2093,1\n"  # QF56OD: neither
    )
    assert kiwi_grid_probe.main(_inputs(tmp_path, csv_text) + ["--list"]) == 0
    out = capsys.readouterr().out
    assert "skimmer grids: 101; wspr reporter grids: 2" in out
    assert "receiver rows read: 3" in out
    assert "matched receivers, RBN only" not in out
    assert "rbn          1 of 3 receivers (33.3%),      5 of 9 answers (55.6%)" in out
    assert "wspr         2 of 3 receivers (66.7%),      8 of 9 answers (88.9%)" in out
    assert "either       2 of 3 receivers (66.7%),      8 of 9 answers (88.9%)" in out
    assert "k1:8073 FN31PR rbn+wspr (5 answers)" in out
    assert "k2:8073 IO91WM wspr (3 answers)" in out
    assert "k3:8073" not in out


# Value: protects=a bad receivers file (no rows, a bad row, a file that isn't UTF-8) stops main with exit 2 and the line, printing no counts; fails_when=main prints 0 of 0 or a smaller count, or a decode error escapes as a traceback (exit 1); why_new=TODOS hardening item; seam=none; no_claim=none beyond protects
@pytest.mark.parametrize(
    ("data", "reason"),
    [
        (b"receiver,lat,lon,answers\n", "no receiver rows"),
        (b"receiver,lat,lon,answers\nk1:8073,41,-72,-1\n", "line 2"),
        (b"receiver,lat,lon,answers\nk1:8073,41,-72,5\nk\xff:8073,41,-72,5\n", "decode"),
    ],
)
def test_main_refuses_a_bad_receivers_file(tmp_path, capsys, data, reason):
    args = _inputs(tmp_path, "")
    Path(args[1]).write_bytes(data)
    assert kiwi_grid_probe.main(args + ["--no-wspr"]) == 2
    out = capsys.readouterr()
    assert out.out == "" and reason in out.err


# Value: protects=--expect-rows (block 9b's count) refuses an export with fewer rows, as a SQL console's capped download would give, and is echoed when it matches; fails_when=a capped download is counted as the whole set; why_new=TODOS hardening item (capped block 9 download); seam=none; no_claim=which consoles cap downloads
def test_main_checks_the_expected_row_count(tmp_path, capsys):
    args = _inputs(tmp_path, "receiver,lat,lon,answers\n" + GOOD_ROW) + ["--no-wspr"]
    assert kiwi_grid_probe.main(args + ["--expect-rows", "2"]) == 2
    assert "1 rows, but block 9b counted 2" in capsys.readouterr().err
    assert kiwi_grid_probe.main(args + ["--expect-rows", "1"]) == 0
    assert "receiver rows read: 1 (as block 9b counted)" in capsys.readouterr().out


# Value: protects=--wspr-days or --expect-rows of 0 or less is an argument error (exit 2) before anything runs, not a wspr.live query read as "missing"; fails_when=a non-positive day count reaches the query; why_new=TODOS hardening item; seam=none; no_claim=none beyond protects
@pytest.mark.parametrize("flag", [["--wspr-days", "0"], ["--wspr-days", "-3"], ["--expect-rows", "0"]])
def test_main_refuses_non_positive_counts(tmp_path, monkeypatch, flag):
    monkeypatch.setattr(kiwi_grid_probe, "wspr_grids", lambda *a, **k: pytest.fail("ran"))
    with pytest.raises(SystemExit) as e:
        kiwi_grid_probe.main(_inputs(tmp_path, "receiver,lat,lon,answers\n" + GOOD_ROW) + flag)
    assert e.value.code == 2


# Value: protects=--list says when its matches are RBN only because wspr.live is missing, so the list isn't read as "no WSPR matches"; fails_when=the RBN-only list prints with no mark; why_new=TODOS hardening item; seam=none (monkeypatches wspr_grids); no_claim=wspr.live itself
def test_main_list_marks_rbn_only_when_wspr_is_missing(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(kiwi_grid_probe, "wspr_grids", lambda days, cache_dir=None: None)
    assert kiwi_grid_probe.main(_inputs(tmp_path, "receiver,lat,lon,answers\n" + GOOD_ROW) + ["--list"]) == 0
    out = capsys.readouterr().out
    assert "matched receivers, RBN only (wspr.live source missing):" in out
    assert "k1:8073 FN31PR rbn (5 answers)" in out


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
        ([{"grid": f"AB{i:02d}CD"} for i in range(100)], False),  # grid-looking records without a callsign
        ([{"call": "", "grid": "FN31PR"}] + FILLER, False),
        (["FN31PR"] + FILLER, False),
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

    cache = wspr_cache_path(7, tmp_path)
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


# Value: protects=the 100 floor counts skimmers like the web rule, so co-located skimmers on one square still pass; fails_when=the floor counts unique squares again; why_new=Step 11 (native + Codex); seam=none; no_claim=RBN's real site density
def test_skimmer_floor_counts_skimmers_not_squares(tmp_path):
    p = tmp_path / "s.json"
    p.write_text(json.dumps([{"call": f"K{i}", "grid": "FN31PR"} for i in range(100)]))
    assert skimmer_grids(p) == {"FN31PR"}


# Value: protects=a missing --skimmers file exits 2 with a reason, as documented; fails_when=main catches only ValueError; why_new=Step 11 native review; seam=none; no_claim=none beyond protects
def test_main_missing_skimmers_file_exits_2(tmp_path, capsys):
    receivers = tmp_path / "r.csv"
    receivers.write_text("receiver,lat,lon,answers\n" + GOOD_ROW)
    assert kiwi_grid_probe.main(["--receivers", str(receivers), "--skimmers", str(tmp_path / "nope.json"), "--no-wspr"]) == 2
    assert "--skimmers" in capsys.readouterr().err


# Value: protects=an unreadable cache is refetched, and a cache that can't be written still returns the fetched grids; fails_when=a cache OSError escapes wspr_grids; why_new=Step 11 (Codex adversarial #2, #3); seam=none (monkeypatches _fetch); no_claim=disk-full timing
def test_cache_read_and_write_failures_never_cost_the_run(tmp_path, monkeypatch):
    from datetime import datetime, timezone

    monkeypatch.setattr(kiwi_grid_probe, "_fetch", lambda url: "FN31PR\n")
    unreadable = tmp_path / "a"
    wspr_cache_path(7, unreadable).mkdir(parents=True)  # a directory: read fails
    assert wspr_grids(7, cache_dir=unreadable) == {"FN31PR"}
    unwritable = tmp_path / "b"
    unwritable.write_text("a file where the cache directory should be")
    assert wspr_grids(7, cache_dir=unwritable) == {"FN31PR"}


# Value: protects=the cache name changes with the query (so an edited query never reads an old reply) and with the day count, and the cache is read and written as UTF-8 whatever the locale; fails_when=the query hash leaves the name, or a non-UTF-8 locale garbles or refuses the cache; why_new=TODOS hardening item (cache name, locale); seam=none (monkeypatches _fetch and the row limit); no_claim=every locale (only the read/write encoding is pinned)
def test_cache_name_follows_the_query_and_is_utf8(tmp_path, monkeypatch):
    a = wspr_cache_path(7, tmp_path)
    assert wspr_cache_path(3, tmp_path) != a
    monkeypatch.setattr(kiwi_grid_probe, "WSPR_ROW_LIMIT", 5)
    assert wspr_cache_path(7, tmp_path) != a  # same days, different query
    monkeypatch.undo()
    monkeypatch.setattr(kiwi_grid_probe, "_fetch", lambda url: "FN31PR\n# Zürich\n")
    assert wspr_grids(7, cache_dir=tmp_path) == {"FN31PR"}
    assert a.read_bytes() == "FN31PR\n# Zürich\n".encode("utf-8")


# Value: protects=a reply that can't be written to the cache (ValueError, as a non-UTF-8 locale's encode error would be) costs only the cache, never the run; fails_when=_save_cache catches only OSError; why_new=TODOS hardening item; seam=none (monkeypatches NamedTemporaryFile); no_claim=which locales fail
def test_cache_encode_error_never_costs_the_run(tmp_path, monkeypatch):
    def broken(*a, **k):
        raise UnicodeEncodeError("ascii", "ü", 0, 1, "ordinal not in range")

    monkeypatch.setattr(kiwi_grid_probe.tempfile, "NamedTemporaryFile", broken)
    monkeypatch.setattr(kiwi_grid_probe, "_fetch", lambda url: "FN31PR\n")
    assert wspr_grids(7, cache_dir=tmp_path) == {"FN31PR"}
