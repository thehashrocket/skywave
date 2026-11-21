"""Tests for the #61 D4 broadcast WSPR coverage probe. Run from the repo root:

    apps/radio/.venv/bin/pytest apps/radio/spikes/spots
"""

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pytest

import broadcast_wspr_probe as probe
from broadcast_wspr_probe import Answer, build_query, load_answers, nearest_band, parse_reply, parse_sites, plan_queries, run_query, summarize

HEADER = "created_ms,picked_ms,freq_khz,kiwi_lat,kiwi_lon,outcome,tx_sites\n"
SITES = json.dumps([{"key": "a", "coords": [[52.0, 5.0], [52.0, 5.0]]}, {"key": "b", "coords": [[48.0, 11.0]]}])
PICK_MS = 1_795_176_000_000  # 2026-11-20 12:00:00 UTC


def row(outcome="heard", picked=str(PICK_MS), freq="9500", lat="51.5", lon="-0.1", sites=SITES, created=str(PICK_MS + 90_000)):
    return ",".join([created, picked, freq, lat, lon, outcome, '"' + sites.replace('"', '""') + '"']) + "\n"


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
    answers, set_aside = load_answers(write(tmp_path, text), 30)
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
        (HEADER + '1,2,9500,51,0,heard,"[\n', "unexpected end of data"),
    ],
)
def test_load_answers_refuses_rows_block_10_cant_produce(tmp_path, text, reason):
    with pytest.raises(ValueError, match=reason):
        load_answers(write(tmp_path, text), 30)


def answer(line=2, end_s=PICK_MS // 1000 - 40, band=10, sites=((52.0, 5.0),), outcome="heard"):
    return Answer(line, end_s - 1800, end_s, band, (51.5, -0.1), sites, outcome)


# Value: protects=each answer's column asks for the smallest "both ends" distance in its own window with minOrNull (no spot -> NULL, never min()'s 0), over the nearest of its sites, on its band; fails_when=min() replaces minOrNull (an empty window reads as a perfect match), the window or band is dropped, or lat/lon swap in greatCircleDistance (which takes lon first); why_new=new probe (D4); seam=none; no_claim=ClickHouse's answer (checked by hand against wspr.live on 2026-11-21)
def test_build_query_asks_for_the_nearest_both_ends_spot_per_window():
    q = build_query([answer(sites=((52.0, 5.0), (48.0, 11.0)))])
    end = PICK_MS // 1000 - 40
    assert q.startswith("SELECT minOrNullIf(greatest(least(greatCircleDistance(tx_lon, tx_lat, 5.000, 52.000), greatCircleDistance(tx_lon, tx_lat, 11.000, 48.000)), ")
    assert f"greatCircleDistance(rx_lon, rx_lat, -0.100, 51.500)), time >= toDateTime({end - 1800}) AND time < toDateTime({end})) AS a0" in q
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


# Value: protects=only a reply that is exactly the header a0..a{n-1} and one row of finite distances or \\N is trusted, \\N becoming "no spot"; fails_when=an error page, an extra or missing column, a second row, or nan/negative is read as distances; why_new=new probe (D4); seam=none; no_claim=ClickHouse's exact NULL spelling beyond TabSeparated's \\N
def test_parse_reply():
    assert parse_reply("a0\ta1\n1200.5\t\\N\n", 2) == [1200.5, None]
    for bad in ["", "a0\ta1\n1\n", "a0\n1\n", "a0\ta1\n1\t2\n3\t4\n", "a1\ta0\n1\t2\n", "a0\ta1\nnan\t1\n", "a0\ta1\n-1\t1\n", "a0\ta1\nx\t1\n", "Code: 241. DB::Exception: Memory limit\n"]:
        assert parse_reply(bad, 2) is None


# Value: protects=a fetch failure or untrusted reply reads as unanswered (None), a reply is cached only once its window is over a day old, and a cached reply is used without asking again; fails_when=a failure becomes "no match", a fresh (still filling) window is cached for good, or the cache is ignored; why_new=new probe (D4); seam=none (monkeypatches _fetch); no_claim=how long wspr.live takes to fill in
def test_run_query_caches_only_settled_windows(tmp_path, monkeypatch):
    calls = []

    def fetch(url):
        calls.append(url)
        return "a0\n5000\n"

    monkeypatch.setattr(probe, "_fetch", fetch)
    now = 2_000_000_000
    assert run_query("Q1", 1, now - 3600, tmp_path, now) == [5000.0]
    assert not list(tmp_path.iterdir())  # an hour old: not cached
    assert run_query("Q2", 1, now - 2 * 86400, tmp_path, now) == [5000.0]
    assert run_query("Q2", 1, now - 2 * 86400, tmp_path, now) == [5000.0]
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
    for junk in (b"a0\n", b"a0\ta1\n1\t2\n", b"a0\n\xff\n"):
        cached.write_bytes(junk)
        assert run_query("Q2", 1, now - 2 * 86400, tmp_path, now) == [5000.0]
    assert len(calls) == 5 and cached.read_text() == "a0\n5000\n"  # each asked again, and the good reply re-cached


# Value: protects=D4's bar: a match is both ends within 1,200 km (inclusive), the verdict is build at 30% or more and stop under it, and any unanswered query or no answers gives no verdict instead of a share; fails_when=the bar moves, NULL counts as a match, or a wspr.live outage turns into "under 30%: stop"; why_new=new probe (D4); seam=none; no_claim=that 1,200 km is the right radius (an owner decision)
def test_summarize_applies_d4s_bar():
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


# Value: protects=the CLI as the owner runs it: reads block 10, asks wspr.live per day and band, prints set-asides, shares and D4's verdict; refuses a missing --window-min (no default window to tip D4), a wrong row count, a window that isn't a multiple of 3, and a bad file with exit 2, and ties the verdict to the window; fails_when=argparse wiring, a guard, or the output breaks, or a default window creeps back; why_new=new probe (D4); seam=none (monkeypatches _fetch); no_claim=wspr.live itself
def test_main(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(probe, "_fetch", lambda url: "a0\ta1\n900000\t\\N\n")
    monkeypatch.setattr(probe, "CACHE_DIR", tmp_path / "cache")
    p = write(tmp_path, HEADER + row() + row(outcome="not_heard") + row(outcome="no_open"))
    assert probe.main(["--answers", str(p), "--window-min", "30", "--expect-rows", "3"]) == 0
    out = capsys.readouterr().out
    assert "answer rows read: 3; probed: 2 in 1 wspr.live queries; window 30 min" in out
    assert "set aside: 1 no_open (the replay drops it)" in out
    assert "both ends within 1,200 km:     1 of 2 (50.0%)" in out
    assert "band  10 (10.1387 MHz): 1 of 2 (50.0%)" in out
    assert "at least 30% matched within 1,200 km: build the broadcast join (D4) [for a 30-min window only]" in out
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
    assert probe.main(["--answers", str(write(tmp_path, HEADER + row())), "--window-min", "30"]) == 0
    out = capsys.readouterr().out
    assert "unanswered: 1" in out and "no verdict: 1 of 1" in out


REPO = Path(__file__).resolve().parents[4]
PROBE = "apps/radio/spikes/spots/broadcast_wspr_probe.py"


# Value: protects=the script runs as the owner will run it (python <path> from the repo root, importing its sibling kiwi_grid_probe) and refuses to run without --window-min, before touching the file or wspr.live; fails_when=the __main__ guard or sibling import breaks, or a default window comes back; why_new=main() was only called in-process; seam=none; no_claim=wspr.live (never reached)
def test_script_refuses_to_run_without_a_window(tmp_path):
    answers = write(tmp_path, HEADER + row())
    out = subprocess.run([sys.executable, PROBE, "--answers", str(answers)], cwd=REPO, capture_output=True, text=True)
    assert out.returncode == 2 and "--window-min" in out.stderr and out.stdout == ""
