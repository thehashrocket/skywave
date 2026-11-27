"""Tests for the #61 D4 broadcast WSPR coverage probe. Run from the repo root:

    apps/radio/.venv/bin/pytest apps/radio/spikes/spots
"""

import dataclasses
import itertools
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pytest

import broadcast_wspr_probe as probe
from broadcast_wspr_probe import Answer, build_query, load_answers, nearest_band, parse_reply, parse_sites, plan_queries, run_query, summarize

HEADER = "created_ms,picked_ms,freq_khz,kiwi_lat,kiwi_lon,outcome,tx_sites\n"
NAMED = HEADER[:-1] + ",tx_name,receiver,report_id\n"  # block 10 since D21 (2026-11-27)
RX = "kiwi.example.org:8073"
SITES = json.dumps([{"key": "a", "coords": [[52.0, 5.0], [52.0, 5.0]]}, {"key": "b", "coords": [[48.0, 11.0]]}])
PICK_MS = 1_795_176_000_000  # 2026-11-20 12:00:00 UTC
_IDS = itertools.count()


def row(outcome="heard", picked=str(PICK_MS), freq="9500", lat="51.5", lon="-0.1", sites=SITES, created=str(PICK_MS + 90_000), name=None, rx=RX, rid=None):
    """A block 10 row; with `name`, also the tx_name, receiver and report_id columns (the
    NAMED header), the report id unique unless `rid` is given."""
    fields = [created, picked, freq, lat, lon, outcome, '"' + sites.replace('"', '""') + '"']
    ids = [name, rx, rid if rid is not None else f"r{next(_IDS)}"] if name is not None else []
    return ",".join(fields + ids) + "\n"


# Value: protects=block 10's identity columns: tx_name read as one sorted station key per question, receiver as the receiver key, report_id kept; an export without them (or with only some, as block 10 was between D21's commits) loads, and the loader names the missing ones from the header; an empty value is refused; fails_when=a column is ignored, a blank value becomes a station, receiver or id, or the header's missing columns go unreported; why_new=new columns (eng review 2026-11-27, D21; owner chose names and keys over sites and positions); seam=none; no_claim=that EiBi names one station the same way all season
def test_load_answers_reads_station_names_and_receivers(tmp_path):
    answers, _, missing = load_answers(write(tmp_path, NAMED + row(name="Radio A / Radio B / Radio A", rid="x1") + row(name="Radio C", rx="other.example:8073")), 3)
    assert [(a.stations, a.receiver) for a in answers] == [(("Radio A", "Radio B"), RX), (("Radio C",), "other.example:8073")]
    assert answers[0].report_id == "x1" and missing == ()
    answers, _, missing = load_answers(write(tmp_path, HEADER + row()), 3)
    assert (answers[0].stations, answers[0].receiver, answers[0].report_id) == (None, None, None)
    assert missing == ("tx_name", "receiver", "report_id")
    answers, _, missing = load_answers(write(tmp_path, HEADER[:-1] + ",tx_name\n" + row()[:-1] + ",Radio A\n"), 3)  # block 10 before receiver
    assert (answers[0].stations, answers[0].receiver) == (("Radio A",), None) and missing == ("receiver", "report_id")
    # Value: protects=a question naming exactly MAX_LISTED (3) stations loads, a repeat counted once before the limit; fails_when=the MAX_LISTED check goes off by one (>=) or counts names before de-duplicating, refusing a real block 10 export; why_new=only 4 names (refused) and 2 names were tested; seam=none; no_claim=none beyond protects
    answers, _, _ = load_answers(write(tmp_path, NAMED + row(name="C / B / A / C")), 3)
    assert answers[0].stations == ("A", "B", "C")
    with pytest.raises(ValueError, match="line 2: tx_name is empty"):
        load_answers(write(tmp_path, NAMED + row(name=" ")), 3)
    with pytest.raises(ValueError, match="line 2: receiver isn't host:port"):
        load_answers(write(tmp_path, NAMED + row(name="Radio A", rx=" ")), 3)
    with pytest.raises(ValueError, match="line 2: report_id is empty"):
        load_answers(write(tmp_path, NAMED + row(name="Radio A", rid=" ")), 3)


# Value: protects=an export block 10 can't produce is refused before it can pad the floor: a repeated report_id (a doubled download), a repeated column name (the last copy would silently win), a receiver that isn't host:port, or a tx_name naming more stations than a question can; fails_when=any of these loads, so 10 answers repeated 5 times, 10 bare numbers or one 10-name question reach a D4 verdict; why_new=Codex outside voice on PR #182, owner D1 (2026-11-27); seam=none; no_claim=that a real Neon export ever does this (it can't)
@pytest.mark.parametrize(
    ("text", "reason"),
    [
        (NAMED + row(name="Radio A", rid="x") + row(name="Radio B", rid="x"), "line 3: report_id 'x' repeats line 2"),
        (NAMED + row(name="Radio A", rid="x", outcome="no_open") + row(name="Radio B", rid="x"), "line 3: report_id 'x' repeats line 2"),  # a set-aside row counts too
        (NAMED[:-1] + ",receiver\n" + row(name="Radio A")[:-1] + ",rx2.example:8073\n", "column receiver appears more than once"),
        (NAMED + row(name="Radio A", rx="12345"), "receiver isn't host:port: '12345'"),
        (NAMED + row(name="Radio A", rx="kiwi.example:0"), "receiver isn't host:port"),
        (NAMED + row(name="Radio A", rx="kiwi.example:99999"), "receiver isn't host:port"),
        (NAMED + row(name="Radio A", rx="kiwi example:8073"), "receiver isn't host:port"),
        # Value: protects=a URL-shaped or hostless receiver is refused, so one Kiwi can't count as two receivers ("http://kiwi:8073" beside "kiwi:8073") or a bare port pass as a receiver; fails_when=the '/' or empty-host check is dropped from the host:port rule; why_new=the four rows above don't reach those two clauses; seam=none; no_claim=that block 10 ever emits a URL
        (NAMED + row(name="Radio A", rx="http://kiwi.example:8073"), "receiver isn't host:port"),
        (NAMED + row(name="Radio A", rx=":8073"), "receiver isn't host:port"),
        (NAMED + row(name="A / B / C / D"), "tx_name names 4 stations; a question names at most 3"),
    ],
)
def test_load_answers_refuses_an_export_block_10_cant_produce(tmp_path, text, reason):
    with pytest.raises(ValueError, match=re.escape(reason)):
        load_answers(write(tmp_path, text), 3)


def write(tmp_path, text):
    p = tmp_path / "b.csv"
    p.write_text(text, encoding="utf-8")
    return p


# Value: protects=each broadcast frequency maps to the WSPR band nearest by ratio, across MW and SW; fails_when=the band table or the ratio rule changes, so a 31 m broadcast is checked against 40 m spots; why_new=new probe (D4); seam=none; no_claim=that the nearest band propagates like the broadcast
@pytest.mark.parametrize(("khz", "band"), [(9500, 10), (6000, 5), (7300, 7), (15400, 14), (1000, 1), (25800, 24), (198, -1), (5900, 5), (11800, 10), (13700, 14)])
def test_nearest_band(khz, band):
    assert nearest_band(khz) == band


# Value: protects=txSites (#72) parses to its distinct coordinates, an unknown site counts as no coordinates, an empty value as no sites, and any other shape is refused; fails_when=a changed txSites shape reads as "no sites" and shrinks the denominator, or a site group is read once per duplicate; why_new=new probe (D4); seam=none; no_claim=the accuracy of EiBi's site table
def test_parse_sites():
    assert parse_sites(SITES) == ((48.0, 11.0), (52.0, 5.0))
    assert parse_sites('[{"key": null, "country": "MDG", "coords": []}]') == ()
    assert parse_sites("") is None and parse_sites("null") is None
    for bad in ["{", '{"key": "a"}', '[{"key": "a"}]', '[{"key": "a", "coords": [[52]]}]', '[{"key": "a", "coords": [["52", 5]]}]', '[{"key": "a", "coords": [[95, 5]]}]']:
        with pytest.raises(ValueError):
            parse_sites(bad)


# Value: protects=a well-formed answer the probe can't score is set aside with its reason (no_open, no Kiwi position, no sites, sites without coordinates) and counted, while a scored answer's window ends 40 s before the pick and runs --window-min; fails_when=set-aside answers vanish uncounted or count as unmatched, or the window drifts from the replay's; why_new=new probe (D4, D6 window); seam=none; no_claim=none beyond protects
def test_load_answers_sets_aside_unscorable_rows_and_places_the_window(tmp_path):
    text = HEADER + row() + row(outcome="no_open") + row(lat="", lon="", picked="") + row(sites="") + row(sites='[{"key": null, "country": "X", "coords": []}]')
    answers, set_aside, _ = load_answers(write(tmp_path, text), 30)
    assert len(answers) == 1
    a = answers[0]
    assert (a.end_s, a.start_s, a.band, a.kiwi, a.outcome) == (PICK_MS // 1000 - 40, PICK_MS // 1000 - 40 - 1800, 10, (51.5, -0.1), "heard")
    assert set_aside == Counter({
        "no_open (the replay drops it)": 1,
        "no Kiwi position (no pick context)": 1,
        "no tx_sites (before #72, or the lookup failed)": 1,
        "tx_sites without coordinates": 1,
    })


# Value: protects=any row block 10 can't have produced, or an export with no rows, stops the load with the line, never becoming a set-aside or a smaller denominator; fails_when=a malformed row is skipped or misfiled; why_new=new probe, same input rule as the grid probe's hardening; seam=none; no_claim=a well-formed export of the wrong query
@pytest.mark.parametrize(
    ("text", "reason"),
    [
        (HEADER, "no answer rows"),
        ("", "no created_ms"),
        (HEADER + row(outcome="maybe"), "outcome isn't one of"),
        (HEADER + row(freq="abc"), "freq_khz"),
        (HEADER + row(freq="88000"), "freq_khz"),
        (HEADER + row(lat=""), "both set or both empty"),
        (HEADER + row(picked=""), "without a whole picked_ms"),
        (HEADER + row(lat="95"), "the Kiwi isn't a position"),
        (HEADER + row(created="x"), "created_ms"),
        (HEADER + row(sites="[1]"), "tx_sites isn't a list"),
        (HEADER + "1,2,3\n", "not 7 fields"),
        (HEADER + row()[:-1] + ",extra\n", "not 7 fields"),
        (HEADER[:-1] + ",ask_rule,ask_region\n" + row()[:-1] + ",1\n", "not 9 fields"),  # short only in a cell the probe doesn't read
        (HEADER + '1,2,9500,51,0,heard,"[\n', "unexpected end of data"),
    ],
)
def test_load_answers_refuses_rows_block_10_cant_produce(tmp_path, text, reason):
    with pytest.raises(ValueError, match=reason):
        load_answers(write(tmp_path, text), 30)


def answer(line=2, end_s=PICK_MS // 1000 - 40, band=10, sites=((52.0, 5.0),), outcome="heard", kiwi=(51.5, -0.1), stations=("Radio A",), receiver=RX, window_s=180, report_id="id"):
    """A scored answer on D4's 3-min window unless `window_s` says otherwise."""
    return Answer(line, end_s - window_s, end_s, band, kiwi, sites, outcome, stations, receiver, report_id and f"{report_id}{line}")


@pytest.fixture
def no_floor(monkeypatch):
    """D21's support floor out of the way, for tests about the 30% bar itself."""
    for name in ("MIN_ANSWERS", "MIN_STATIONS", "MIN_RECEIVERS"):
        monkeypatch.setattr(probe, name, 1)


# Value: protects=each answer's columns ask for the smallest "both ends" distance in its own window with minOrNull (no spot -> NULL, never min()'s 0), over the nearest of its sites, on its band, and for the band's spot count in that same window; fails_when=min() replaces minOrNull (an empty window reads as a perfect match), the window or band is dropped, the count reads another window, or lat/lon swap in greatCircleDistance (which takes lon first); why_new=new probe (D4); seam=none; no_claim=ClickHouse's answer (checked by hand against wspr.live on 2026-11-21)
def test_build_query_asks_for_the_nearest_both_ends_spot_per_window():
    q = build_query([answer(sites=((52.0, 5.0), (48.0, 11.0)), window_s=1800)])
    end = PICK_MS // 1000 - 40
    assert q.startswith("SELECT minOrNullIf(greatest(least(greatCircleDistance(tx_lon, tx_lat, 5.000, 52.000), greatCircleDistance(tx_lon, tx_lat, 11.000, 48.000)), ")
    assert f"greatCircleDistance(rx_lon, rx_lat, -0.100, 51.500)), time >= toDateTime({end - 1800}) AND time < toDateTime({end})) AS a0, countIf(time >= toDateTime({end - 1800}) AND time < toDateTime({end})) AS c0 FROM" in q
    assert q.endswith(f"FROM wspr.rx WHERE band = 10 AND time >= toDateTime({end - 1800}) AND time < toDateTime({end}) FORMAT TabSeparatedWithNames")


# Value: protects=queries are one per UTC day and band, split only when a URL would pass MAX_URL, and an answer too big for one URL is refused; fails_when=answers on different bands or days share a query (wrong band filter), a long day is sent as one over-long URL (nginx refuses it, every answer reads as missing), or an answer is dropped between chunks; why_new=new probe (D4; wspr.live refuses POST); seam=none (monkeypatches MAX_URL); no_claim=nginx's exact limit
def test_plan_queries_groups_by_day_and_band_and_splits_long_ones(monkeypatch):
    day1 = PICK_MS // 1000
    answers = [answer(line=2, end_s=day1), answer(line=3, end_s=day1 + 60, band=7), answer(line=4, end_s=day1 + 86400), answer(line=5, end_s=day1 + 120)]
    plans = plan_queries(answers)
    assert sorted(tuple(a.line for a in chunk) for chunk, _ in plans) == [(2, 5), (3,), (4,)]
    one = len(probe.query_url(build_query([answers[0]])))
    monkeypatch.setattr(probe, "MAX_URL", one + 50)
    many = [answer(line=i, end_s=day1 + i) for i in range(10)]
    plans = plan_queries(many)
    assert len(plans) > 1 and [a.line for chunk, _ in plans for a in chunk] == list(range(10))
    assert all(len(probe.query_url(q)) <= one + 50 for _, q in plans)
    monkeypatch.setattr(probe, "MAX_URL", 100)
    with pytest.raises(ValueError, match="longer than 100"):
        plan_queries([answers[0]])


# Value: protects=only a reply that is exactly the header a0, c0, ..., a{n-1}, c{n-1} and one row of finite distances or \\N with whole counts is trusted, \\N becoming "no near spot" and a 0 count "no spot on the band at all"; fails_when=an error page, an extra or missing column, a second row, nan/negative, a non-whole or NULL count, or a distance with a 0 count is read as a reply; why_new=new probe (D4); seam=none; no_claim=ClickHouse's exact NULL spelling beyond TabSeparated's \\N
def test_parse_reply():
    H = "a0\tc0\ta1\tc1\n"
    assert parse_reply(H + "1200.5\t7\t\\N\t0\n", 2) == [(1200.5, 7), (None, 0)]
    for bad in ["", H + "1\t1\n", "a0\tc0\n1\t1\n", H + "1\t1\t2\t1\n3\t1\t4\t1\n", "c0\ta0\tc1\ta1\n1\t1\t2\t1\n", "a0\ta1\tc0\tc1\n1\t2\t1\t1\n",
                H + "nan\t1\t1\t1\n", H + "-1\t1\t1\t1\n", H + "x\t1\t1\t1\n", H + "1\t\\N\t1\t1\n", H + "1\t1.5\t1\t1\n", H + "1\t-1\t1\t1\n", H + "1\t0\t1\t1\n",
                "Code: 241. DB::Exception: Memory limit\n"]:
        assert parse_reply(bad, 2) is None


# Value: protects=a fetch failure or untrusted reply reads as unanswered (None), a reply is cached only once its window is over a day old, and a cached reply is used without asking again; fails_when=a failure becomes "no match", a fresh (still filling) window is cached for good, or the cache is ignored; why_new=new probe (D4); seam=none (monkeypatches _fetch); no_claim=how long wspr.live takes to fill in
def test_run_query_caches_only_settled_windows(tmp_path, monkeypatch):
    calls = []

    def fetch(url):
        calls.append(url)
        return "a0\tc0\n5000\t3\n"

    monkeypatch.setattr(probe, "_fetch", fetch)
    now = 2_000_000_000
    assert run_query("Q1", 1, now - 3600, tmp_path, now) == [(5000.0, 3)]
    assert not list(tmp_path.iterdir())  # an hour old: not cached
    assert run_query("Q2", 1, now - 2 * 86400, tmp_path, now) == [(5000.0, 3)]
    assert run_query("Q2", 1, now - 2 * 86400, tmp_path, now) == [(5000.0, 3)]
    assert len(calls) == 2  # Q2's second ask came from the cache

    def down(url):
        raise OSError("down")

    monkeypatch.setattr(probe, "_fetch", down)
    assert run_query("Q3", 1, now - 2 * 86400, tmp_path, now) is None
    monkeypatch.setattr(probe, "_fetch", lambda url: "<html>busy</html>")
    assert run_query("Q4", 1, now - 2 * 86400, tmp_path, now) is None
    assert len(list(tmp_path.iterdir())) == 1  # only Q2's reply

    # Value: protects=a cached reply that no longer parses (cut write, wrong width, not UTF-8) is asked again, never returned and never read as unanswered; fails_when=a bad cache is trusted or turns its answers "missing" for good; why_new=only a good cache hit was tested; seam=none (monkeypatches _fetch); no_claim=how a cache gets damaged
    (cached,) = tmp_path.iterdir()
    monkeypatch.setattr(probe, "_fetch", fetch)
    for junk in (b"a0\tc0\n", b"a0\tc0\ta1\tc1\n1\t1\t2\t1\n", b"a0\tc0\n\xff\t1\n"):
        cached.write_bytes(junk)
        assert run_query("Q2", 1, now - 2 * 86400, tmp_path, now) == [(5000.0, 3)]
    assert len(calls) == 5 and cached.read_text() == "a0\tc0\n5000\t3\n"  # each asked again, and the good reply re-cached


# Value: protects=D4's bar: a match is both ends within 1,200 km (inclusive), the verdict is build at 30% or more and stop under it, and any unanswered query or no answers gives no verdict instead of a share; fails_when=the bar moves, NULL counts as a match, or a wspr.live outage turns into "under 30%: stop"; why_new=new probe (D4); seam=none; no_claim=that 1,200 km is the right radius (an owner decision)
def test_summarize_applies_d4s_bar(no_floor):
    a = [answer(line=i, outcome="heard" if i % 2 else "not_heard") for i in range(10)]
    near = {0: 1_200_000.0, 1: 599_000.0, 2: 250_000.0}
    s = summarize(a, {**{i: 5_000_000.0 for i in range(3, 10)}, **near}, set())
    assert s["near"] == {300: 1, 600: 2, 1200: 3} and s["share"] == 0.3
    assert s["verdict"].startswith("at least 30% matched")
    assert s["by_outcome"] == {"heard": [1, 5], "not_heard": [2, 5]}
    s = summarize(a, {**{i: None for i in range(10)}, 0: 1_200_001.0, 1: 1000.0, 2: 1000.0}, set())
    assert s["share"] == 0.2 and s["verdict"].startswith("under 30% matched")
    s = summarize(a, {i: 1000.0 for i in range(9)}, {9})
    assert s["verdict"].startswith("no verdict: 1 of 10") and s["scored"] == 9
    assert summarize([], {}, set())["verdict"].startswith("no verdict: no broadcast answers")
    # Value: protects=an answer whose band had no spot anywhere in its window (a wspr.live gap) is counted apart and left out of the share, never as unmatched, and all-quiet gives no verdict; fails_when=a data gap counts against D4's 30% bar and tips it to stop; why_new=Step 9 Red Team finding (owner chose fix, 2026-11-21); seam=none; no_claim=which bands are ever quiet worldwide
    s = summarize(a, {**{i: None for i in range(10)}, 0: 1000.0, 1: 1000.0, 2: 1000.0}, set(), {3, 4, 5, 6, 7, 8, 9})
    assert s["scored"] == 3 and s["quiet"] == 7 and s["share"] == 1.0 and s["share_quiet_missed"] == 0.3 and s["verdict"].startswith("at least 30% matched")
    # Value: protects=a verdict only when the share without quiet answers and the share counting them as misses agree, so mostly-quiet data can't say build on a few answers (nor an outage say stop); fails_when=quiet answers leave the denominator and a handful of matches clears the bar; why_new=Step 11 targeted reader (owner D4, 2026-11-21); seam=none; no_claim=how many answers are quiet in practice
    s = summarize(a, {**{i: None for i in range(10)}, 0: 1000.0, 1: 1000.0}, set(), {2, 3, 4, 5, 6, 7, 8, 9})
    assert s["share"] == 1.0 and s["share_quiet_missed"] == 0.2 and s["verdict"].startswith("no verdict: the 8 quiet answers decide it (100.0% without them, 20.0% counting")
    s = summarize(a, {**{i: None for i in range(10)}, 0: 1000.0}, set(), {5, 6})
    assert s["verdict"].startswith("under 30% matched")  # 1 of 8 and 1 of 10: both under
    assert summarize(a, {}, set(), set(range(10)))["verdict"] == "no verdict: no answer's band had any WSPR spot in its window"


def _spread(n: int, stations: int, receivers: int) -> list:
    """n answers cycling over `stations` station names and `receivers` receiver keys; every answer
    has its own site list and its own Kiwi position, so neither can stand in for the count."""
    return [
        answer(line=i, sites=((40.0 + i % 37, 5.0),), stations=(f"Radio {i % stations}",), receiver=f"rx{i % receivers}.example:8073", kiwi=(10.0 + i * 0.01, 0.0))
        for i in range(n)
    ]


# Value: protects=D21's support floor: D4 gets a verdict only with >= 50 scored answers from >= 10 stations (by tx_name, never by site list) and >= 10 receivers (by receiver key, never by position), quiet and unanswered ones not counting, and an export without either column (or without just one) gets none; fails_when=the floor is dropped, counts unscored answers, counts site lists or positions (one receiver that moved passes), or an unkeyed export (tx_name but no receiver) slips through; why_new=new rule (eng review 2026-11-27, D21; owner chose names and keys); seam=none; no_claim=that 50/10/10 is enough (an owner decision)
def test_summarize_needs_d21s_support():
    def verdict(answers, quiet=frozenset()):
        return summarize(answers, {a.line: 1000.0 for a in answers}, set(), quiet)["verdict"]

    assert verdict(_spread(50, 10, 10)).startswith("at least 30% matched")
    s = summarize(_spread(50, 10, 10), {i: 1000.0 for i in range(50)}, set())
    assert (s["scored"], s["stations"], s["receivers"], s["decided"]) == (50, 10, 10, True)
    assert verdict(_spread(49, 10, 10)) == "no verdict: not enough broadcast data (49 scored answers, 10 stations, 10 receivers; D21 needs 50, 10 and 10)"
    assert verdict(_spread(50, 9, 10)).startswith("no verdict: not enough broadcast data (50 scored answers, 9 stations")  # 37 site lists, 9 stations
    assert verdict(_spread(50, 10, 9)).startswith("no verdict: not enough broadcast data (50 scored answers, 10 stations, 9 receivers")  # 50 positions, 9 receivers
    assert verdict(_spread(51, 10, 10), quiet={50, 0}).startswith("no verdict: not enough broadcast data (49 scored")
    # A quiet or unanswered answer's station and receiver don't count toward the floor either.
    extra = _spread(50, 9, 9) + [answer(line=50, stations=("Radio 9",), receiver="rx9.example:8073")]
    s = summarize(extra, {a.line: 1000.0 for a in extra}, set(), {50})
    assert (s["scored"], s["stations"], s["receivers"]) == (50, 9, 9) and s["verdict"].startswith("no verdict: not enough broadcast data")
    s = summarize(extra, {a.line: 1000.0 for a in extra}, {50})
    assert (s["scored"], s["stations"], s["receivers"]) == (50, 9, 9)
    unnamed = [answer(line=i, stations=None, receiver=f"rx{i % 10}.example:8073") for i in range(50)]
    assert verdict(unnamed) == "no verdict: this export has no tx_name column, so D21's floor can't be checked; rerun block 10"
    assert summarize(unnamed, {}, set())["stations"] is None
    old = [answer(line=i, stations=None, receiver=None, report_id=None) for i in range(50)]
    assert verdict(old) == "no verdict: this export has no tx_name or receiver or report_id columns, so D21's floor can't be checked; rerun block 10"
    assert summarize(old, {}, set())["receivers"] is None
    unkeyed = [answer(line=i, stations=(f"Radio {i % 10}",), receiver=None) for i in range(50)]
    assert verdict(unkeyed) == "no verdict: this export has no receiver column, so D21's floor can't be checked; rerun block 10"
    unidentified = [dataclasses.replace(a, report_id=None) for a in _spread(50, 10, 10)]
    assert verdict(unidentified) == "no verdict: this export has no report_id column, so D21's floor can't be checked; rerun block 10"


# Value: protects=owner D2: a question that named two or three stations counts once toward the 10-station floor, as its sorted group, so four answers on one shared frequency can't fill it; fails_when=joined names count one each again; why_new=both reviewers on PR #182 (owner D2, 2026-11-27); seam=none; no_claim=that a single station and a group holding it are different paths (they count twice, by choice)
def test_a_joined_question_counts_once():
    groups = [("A", "B", "C"), ("D", "E", "F"), ("G", "H", "I"), ("A", "J")]
    a = [answer(line=i, stations=groups[i % 4], receiver=f"rx{i % 10}.example:8073") for i in range(50)]
    s = summarize(a, {i: 1000.0 for i in range(50)}, set())
    assert s["stations"] == 4 and s["verdict"].startswith("no verdict: not enough broadcast data (50 scored answers, 4 stations")
    a = [answer(line=i, stations=("A",) if i % 2 else ("A", "B"), receiver=f"rx{i % 10}.example:8073") for i in range(4)]
    assert summarize(a, {i: 1000.0 for i in range(4)}, set())["stations"] == 2  # "A" alone and the group "A / B"


# Value: protects=owner D3: the output shows the largest receiver's and station's share of the scored answers, so a lopsided sample that still passes 50/10/10 is visible; fails_when=the shares are dropped or taken over unscored answers; why_new=both reviewers on PR #182 (owner D3, 2026-11-27: report, not gate); seam=none; no_claim=what share is too lopsided (an owner call per run)
def test_summarize_reports_the_largest_shares():
    a = [answer(line=i, stations=("Big",) if i < 41 else (f"S{i}",), receiver=RX if i < 41 else f"rx{i}.example:8073") for i in range(50)]
    s = summarize(a, {i: 1000.0 for i in range(50)}, set())
    assert s["verdict"].startswith("at least 30% matched")  # the floor is met: report, not gate
    assert (s["top_receiver_share"], s["top_station_share"]) == (0.82, 0.82)
    s = summarize(a, {i: 1000.0 for i in range(50)}, set(), set(range(40)))  # 40 of the big pair quiet
    assert (s["scored"], s["top_receiver_share"]) == (10, 0.1)
    assert summarize([], {}, set())["top_receiver_share"] is None


# Value: protects=owner D4: summarize itself gives no D4 verdict off the 3-min window (read from the answers), and an answer with no wspr.live result at all counts as unanswered, never as a miss, so a caller that skips the query can't get "stop"; fails_when=the window check lives only in the CLI, or a missing result reads as no match; why_new=Codex on PR #182 (owner D4, 2026-11-27); seam=none; no_claim=none beyond protects
def test_summarize_guards_the_window_and_missing_results():
    a = [answer(line=i, stations=(f"S{i % 10}",), receiver=f"rx{i % 10}.example:8073", window_s=1800) for i in range(50)]
    s = summarize(a, {i: 1000.0 for i in range(50)}, set())
    assert s["verdict"] == "no D4 verdict: exploratory 30-min window; D4 is decided at 3 min (D21)" and not s["decided"]
    assert s["share"] == 1.0  # the shares are still given
    s = summarize(_spread(50, 10, 10), {}, set())
    assert (s["scored"], s["unanswered"], s["decided"]) == (0, 50, False) and s["verdict"].startswith("no verdict: 50 of 50 answers got no usable wspr.live reply")
    s = summarize(_spread(50, 10, 10), {i: None for i in range(49)}, set())
    assert s["unanswered"] == 1 and s["verdict"].startswith("no verdict: 1 of 50")
    # Value: protects=windows are compared in exact seconds, so a 181-s window is exploratory, not D4's 3 min; fails_when=durations are floored to whole minutes again (181-239 s pass as 3 min); why_new=Codex on PR #182 final review (owner D1 run 3); seam=none; no_claim=none beyond protects
    a = [answer(line=i, stations=(f"S{i % 10}",), receiver=f"rx{i % 10}.example:8073", window_s=181) for i in range(50)]
    assert summarize(a, {i: 1000.0 for i in range(50)}, set())["verdict"] == "no D4 verdict: exploratory 3.01667-min window; D4 is decided at 3 min (D21)"


# Value: protects=no D4 verdict while any answered window (scored or quiet) ended under 24 h ago (wspr.live is still filling it in, the rule that already keeps such replies out of the cache), with the time to run again; fails_when=a fresh export gets a final build/stop that late spots could flip; why_new=Codex on PR #182 final review, owner D1 (2026-11-27, run 3); seam=none (now_s parameter, which main leaves to the clock); no_claim=how late wspr.live spots really arrive
def test_summarize_waits_for_settled_windows():
    a = _spread(50, 10, 10)
    end = a[0].end_s
    dist = {i: 1000.0 for i in range(50)}
    assert summarize(a, dist, set(), now_s=end + 24 * 3600)["decided"]
    s = summarize(a, dist, set(), now_s=end + 24 * 3600 - 1)
    assert not s["decided"] and s["verdict"].startswith("no verdict: 50 answers' windows ended under 24 h ago and wspr.live is still filling them in; run again after 2026-11-21 12:00 UTC")
    # Value: protects=a fresh quiet answer holds a settled stop (its band is often quiet only because wspr.live hasn't loaded the spots yet); fails_when=the wait looks at scored answers only, so 14/50 settled plus 2 fresh quiet answers stops, then builds at 16/52 once the spots arrive; why_new=all three PR #182 run 4 reviewers, owner D1 (2026-11-27); seam=none; no_claim=how often a fresh window is really quiet
    far = {i: 5_000_000.0 for i in range(50)}
    fresh_quiet = answer(line=50, end_s=end + 3600, stations=("Radio 0",))
    assert "stop the broadcast half" in summarize(a, far, set(), now_s=end + 24 * 3600)["verdict"]  # settled: a final stop
    s = summarize(a + [fresh_quiet], far, set(), {50}, now_s=end + 24 * 3600)
    assert not s["decided"] and s["verdict"].startswith("no verdict: 1 answers' windows ended under 24 h ago")
    # Value: protects=two fresh answers among 48 settled ones still hold the verdict, counted alone (2), with the rerun time taken from the latest window; fails_when=the check needs all (or the first) windows fresh, counts every scored answer, or names the earliest end as the rerun time; why_new=the fixture above ends every window at once, so any/all and max/min read the same (ship coverage audit, 2026-11-27); seam=none; no_claim=none beyond protects
    late = [dataclasses.replace(x, start_s=x.start_s + d, end_s=x.end_s + d) if (d := {7: 3600, 8: 1800}.get(x.line)) else x for x in a]
    s = summarize(late, dist, set(), now_s=end + 24 * 3600)
    assert not s["decided"] and s["verdict"].startswith("no verdict: 2 answers' windows ended under 24 h ago and wspr.live is still filling them in; run again after 2026-11-21 13:00 UTC")


# Value: protects=the CLI as the owner runs it: reads block 10, asks wspr.live per day and band, prints set-asides, shares and D4's verdict; refuses a missing --window-min (no default window to tip D4), a wrong row count, a window that isn't a multiple of 3, and a bad file with exit 2, and ties the verdict to the window; fails_when=argparse wiring, a guard, or the output breaks, or a default window creeps back; why_new=new probe (D4); seam=none (monkeypatches _fetch); no_claim=wspr.live itself
def test_main(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(probe, "_fetch", lambda url: "a0\tc0\ta1\tc1\n900000\t4\t\\N\t4\n")
    monkeypatch.setattr(probe, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(probe.time, "time", lambda: PICK_MS / 1000 + 3 * 86400)  # windows settled: replies are cached
    p = write(tmp_path, HEADER + row() + row(outcome="not_heard") + row(outcome="no_open"))
    assert probe.main(["--answers", str(p), "--window-min", "30", "--expect-rows", "3"]) == 3  # no D4 verdict: exit 3
    out = capsys.readouterr().out
    assert "answer rows read: 3; probed: 2 in 1 wspr.live queries; window 30 min" in out
    assert "set aside: 1 no_open (the replay drops it)" in out
    assert "both ends within 1,200 km:     1 of 2 (50.0%)" in out
    assert "band  10 (10.1387 MHz): 1 of 2 (50.0%)" in out
    assert "support: 2 scored answers, no tx_name column, no receiver column" in out
    # Value: protects=D21: only the 3-min window gives a D4 verdict; any other length prints its shares as exploratory with none, and at 3 min a thin sample says "not enough broadcast data"; fails_when=a longer window's (higher) share reaches the D4 verdict, or the floor is skipped in the CLI; why_new=new rule (eng review 2026-11-27, D21); seam=none (monkeypatches _fetch); no_claim=wspr.live itself
    assert "no D4 verdict: exploratory 30-min window; D4 is decided at 3 min (D21)" in out and "build the broadcast join" not in out
    assert len(list((tmp_path / "cache").iterdir())) == 1  # the cache follows CACHE_DIR, never the real one
    assert probe.main(["--answers", str(p), "--window-min", "3"]) == 3
    out = capsys.readouterr().out
    assert "no tx_name or receiver or report_id columns, so D21's floor can't be checked; rerun block 10\n" in out and "D4's]" not in out
    named = tmp_path / "named.csv"  # not write(): that reuses b.csv, which the checks below read
    named.write_text(NAMED + row(name="Radio A") + row(outcome="not_heard", name="Radio B / Radio C", rx="other.example:8073"), encoding="utf-8")
    assert probe.main(["--answers", str(named), "--window-min", "3"]) == 3
    out = capsys.readouterr().out
    assert "support: 2 scored answers, 2 stations, 2 receivers" in out  # the joined question counts once (D2)
    assert "largest receiver: 50% of scored answers; largest station: 50%" in out
    assert "no verdict: not enough broadcast data (2 scored answers, 2 stations, 2 receivers; D21 needs 50, 10 and 10)\n" in out
    # Value: protects=an old export whose rows were all set aside still says which identity columns it lacks (from its header), not "0 stations"; fails_when=column presence is read from the rows again; why_new=Codex on PR #182 (owner D1); seam=none; no_claim=none beyond protects
    old_aside = tmp_path / "aside.csv"
    old_aside.write_text(HEADER + row(outcome="no_open"), encoding="utf-8")
    assert probe.main(["--answers", str(old_aside), "--window-min", "3"]) == 3
    out = capsys.readouterr().out
    assert "support: 0 scored answers, no tx_name column, no receiver column" in out
    assert "no verdict: no broadcast answers the probe can score; this export has no tx_name or receiver or report_id columns either: rerun block 10" in out
    assert probe.main(["--answers", str(p), "--window-min", "30", "--expect-rows", "4"]) == 2
    assert "3 rows, but block 10b counted 4" in capsys.readouterr().err
    for argv in (["--window-min", "10"], []):
        with pytest.raises(SystemExit) as e:
            probe.main(["--answers", str(p), *argv])
        assert e.value.code == 2
    bad = write(tmp_path, HEADER + row(outcome="maybe"))
    assert probe.main(["--answers", str(bad), "--window-min", "30"]) == 2
    assert "line 2" in capsys.readouterr().err
    monkeypatch.setattr(probe, "_fetch", lambda url: (_ for _ in ()).throw(OSError("down")))
    assert probe.main(["--answers", str(write(tmp_path, HEADER + row())), "--window-min", "3"]) == 3
    out = capsys.readouterr().out
    assert "unanswered: 1" in out and "no verdict: 1 of 1" in out
    for name in ("MIN_ANSWERS", "MIN_STATIONS", "MIN_RECEIVERS"):  # the floor out of the way: quiet answers below
        monkeypatch.setattr(probe, name, 1)
    monkeypatch.setattr(probe, "CACHE_DIR", tmp_path / "cache2")
    monkeypatch.setattr(probe, "_fetch", lambda url: "a0\tc0\ta1\tc1\n\\N\t0\t900000\t2\n")
    assert probe.main(["--answers", str(write(tmp_path, NAMED + row(name="Radio A") + row(outcome="not_heard", name="Radio A"))), "--window-min", "3"]) == 0
    out = capsys.readouterr().out
    assert "no WSPR spot on the band anywhere in the window: 1" in out and "within 1,200 km:     1 of 1 (100.0%)" in out
    assert "counting quiet answers as misses: 50.0%" in out
    assert "build the broadcast join (D4) [3-min window: D4's]" in out  # a D4 verdict: exit 0 (asserted above)


REPO = Path(__file__).resolve().parents[4]
PROBE = "apps/radio/spikes/spots/broadcast_wspr_probe.py"


# Value: protects=the script runs as the owner will run it (python <path> from the repo root, importing its sibling kiwi_grid_probe) and refuses to run without --window-min, before touching the file or wspr.live; fails_when=the __main__ guard or sibling import breaks, or a default window comes back; why_new=main() was only called in-process; seam=none; no_claim=wspr.live (never reached)
def test_script_refuses_to_run_without_a_window(tmp_path):
    answers = write(tmp_path, HEADER + row())
    out = subprocess.run([sys.executable, PROBE, "--answers", str(answers)], cwd=REPO, capture_output=True, text=True)
    assert out.returncode == 2 and "--window-min" in out.stderr and out.stdout == ""
