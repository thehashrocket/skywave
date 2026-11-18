import re
import sqlite3
import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from skywave_radio.noise import (
    MIN_NOISE_BINS,
    NOISE_BANDS,
    NOISE_ZOOM,
    SAMPLE_INTERVAL_S,
    WINDOW_DAYS,
    NoiseSampler,
    NoiseStore,
    bands_in,
    hist_median,
    noise_floor,
    utc_slot,
)
from skywave_radio.scan import sweep
from skywave_radio.server import NOISE_MAX_RECEIVERS, create_app, parse_receivers
from skywave_radio.waterfall import WaterfallFrame

from .test_server import ORIGIN, run_with_fake, settings, tune_msg, until_state

WEB_TYPES = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "radio-types.ts"
SPAN_Z6 = 30_000 / 2**6
NOISE = 60
RNG = np.random.default_rng(67)


def frame(start_khz=7_000.0, span_khz=SPAN_Z6, bins=None, zoom=NOISE_ZOOM) -> WaterfallFrame:
    if bins is None:
        bins = np.full(1024, NOISE, dtype=np.uint8)
    return WaterfallFrame(zoom=zoom, start_khz=start_khz, span_khz=span_khz, bins=np.asarray(bins, dtype=np.uint8))


def noisy(level=NOISE, spread=3) -> np.ndarray:
    return np.clip(RNG.normal(level, spread, 1024), 1, 255).astype(np.uint8)


# --- noise_floor ---


def test_flat_noise_reads_as_its_level():
    assert noise_floor(frame(bins=np.full(1024, NOISE)), 7_000, 7_300) == pytest.approx(NOISE)


def test_gaussian_noise_reads_a_little_under_its_mean():
    floor = noise_floor(frame(bins=noisy(NOISE, 3)), 7_000, 7_400)
    # The 20th percentile of N(60, 3) is about 57.5.
    assert floor == pytest.approx(NOISE - 0.84 * 3, abs=0.6)


def test_strong_carriers_dont_lift_the_floor():
    bins = noisy(NOISE, 3)
    # A busy broadcast band by day: 60% of the bins carry signals 20-60 dB up.
    busy = RNG.choice(1024, size=614, replace=False)
    bins[busy] = np.clip(NOISE + RNG.uniform(20, 60, busy.size), 0, 255).astype(np.uint8)
    floor = noise_floor(frame(bins=bins), 7_000, 7_400)
    assert floor is not None and abs(floor - NOISE) < 4
    # The median (what find_peaks measures against) is dragged far up.
    assert float(np.median(bins)) > NOISE + 5


def test_a_partly_blank_frame_ignores_the_blank_bins():
    bins = noisy(NOISE, 2)
    bins[:600] = 0  # off the receiver's coverage
    floor = noise_floor(frame(bins=bins), 7_000, 7_400)
    assert floor is not None and abs(floor - NOISE) < 3


def test_a_mostly_blank_frame_gives_no_floor():
    bins = noisy(NOISE, 2)
    bins[: 1024 - (MIN_NOISE_BINS - 1)] = 0
    assert noise_floor(frame(bins=bins), 7_000, 7_469) is None


def test_only_bins_inside_the_range_count():
    # Left half quiet, right half 30 dB up: a range over the left half reads quiet.
    bins = np.full(1024, NOISE, dtype=np.uint8)
    bins[512:] = NOISE + 30
    f = frame(start_khz=7_000.0, bins=bins)
    mid = 7_000 + SPAN_Z6 / 2
    assert noise_floor(f, 7_000, mid - 1) == pytest.approx(NOISE)
    assert noise_floor(f, mid + 1, 7_000 + SPAN_Z6) == pytest.approx(NOISE + 30)


def test_the_receivers_offset_moves_the_range():
    bins = np.full(1024, NOISE, dtype=np.uint8)
    bins[512:] = NOISE + 30
    # Baseband 0..469 kHz behind a 7 MHz offset is 7000..7469 kHz RF.
    f = frame(start_khz=0.0, bins=bins)
    assert noise_floor(f, 7_000, 7_200, offset_khz=7_000) == pytest.approx(NOISE)


def test_too_few_bins_in_range_gives_none():
    f = frame(start_khz=7_000.0)
    khz_per_bin = SPAN_Z6 / 1024
    assert noise_floor(f, 7_000, 7_000 + (MIN_NOISE_BINS - 2) * khz_per_bin) is None
    assert noise_floor(f, 8_000, 8_100) is None  # outside the frame


# --- Bands ---


def test_bands_mirror_the_dials_band_lists():
    text = WEB_TYPES.read_text()

    def parse(const):
        block = text[text.index(f"export const {const}") :]
        block = block[: block.index("];")]
        return [(n, float(a), float(b)) for n, a, b in re.findall(r'name: "(\w+)", startKhz: (\d+), endKhz: (\d+)', block)]

    web = [(f"bc-{n}", a, b) for n, a, b in parse("BROADCAST_BANDS")] + [
        (f"ham-{n}", a, b) for n, a, b in parse("HAM_BANDS")
    ]
    assert [(b.id, b.start_khz, b.end_khz) for b in NOISE_BANDS] == web


def test_a_frame_can_overlap_a_broadcast_and_a_ham_band():
    ids = {b.id for b in bands_in(7_090, 7_560)}
    assert ids == {"ham-40m", "bc-41m"}


def test_utc_slot():
    # 2026-11-18 21:30 UTC
    at = 1_795_037_400
    day, hour = utc_slot(at)
    assert hour == 21 and day == at // 86_400


# --- Medians from histograms ---


@pytest.mark.parametrize(
    "hist,expected",
    [
        ([], (None, 0)),
        ([(50, 1)], (50, 1)),
        ([(50, 1), (60, 1)], (55, 2)),
        ([(50, 2), (60, 1)], (50, 3)),
        ([(70, 1), (50, 2), (60, 2)], (60, 5)),
        ([(50, 0), (60, 3)], (60, 3)),
    ],
)
def test_hist_median(hist, expected):
    assert hist_median(hist) == expected


# --- Store ---


class Clock:
    def __init__(self, t=0.0):
        self.t = t

    def __call__(self):
        return self.t


def test_the_store_keeps_medians_per_band_and_hour_and_a_baseline():
    hour = 3_600
    store = NoiseStore(":memory:")
    base = 20_000 * 86_400 + 10 * hour  # day 20000, 10:00 UTC
    for level in (50, 52, 54):
        store.add("a.example:8073", "ham-40m", base, level)
    store.add("a.example:8073", "ham-40m", base + hour, 90)  # 11:00: another hour
    store.add("a.example:8073", "ham-20m", base, 70)
    store.add("b.example:8073", "ham-40m", base - 86_400, 40)  # yesterday, same hour
    stats = store.stats(["a.example:8073", "b.example:8073", "c.example:8073"], "ham-40m", base).result(5)
    store.close()
    a, b = stats["a.example:8073"], stats["b.example:8073"]
    assert (a.median_db, a.count) == (52, 3)
    assert (a.baseline_db, a.baseline_count) == (54, 5)  # 50 52 54 70 90
    assert (b.median_db, b.count, b.baseline_db) == (40, 1, 40)
    assert "c.example:8073" not in stats


def test_the_store_forgets_samples_older_than_the_window():
    store = NoiseStore(":memory:")
    day = 20_000
    store.add("a:8073", "ham-40m", (day - WINDOW_DAYS) * 86_400, 99)  # 30 days ago: out
    store.add("a:8073", "ham-40m", (day - WINDOW_DAYS + 1) * 86_400, 50)  # 29 days ago: in
    stats = store.stats(["a:8073"], "ham-40m", day * 86_400).result(5)
    # A sample today prunes the old day from disk too.
    store.add("a:8073", "ham-40m", day * 86_400, 50)
    rows = store.submit(lambda c: c.execute("SELECT MIN(day) FROM noise_hist").fetchone()[0]).result(5)
    store.close()
    assert (stats["a:8073"].median_db, stats["a:8073"].count) == (50, 1)
    assert rows == day - WINDOW_DAYS + 1


def test_the_store_survives_a_restart_on_disk(tmp_path):
    path = str(tmp_path / "noise.sqlite3")
    store = NoiseStore(path)
    store.add("a:8073", "bc-31m", 20_000 * 86_400, 61)
    store.close()
    again = NoiseStore(path)
    stats = again.stats(["a:8073"], "bc-31m", 20_000 * 86_400).result(5)
    again.close()
    assert stats["a:8073"].median_db == 61
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM noise_hist").fetchone()[0] == 1


def test_adding_never_waits_on_the_disk():
    store = NoiseStore(":memory:")
    started = time.perf_counter()
    for i in range(500):
        store.add("a:8073", "ham-40m", 20_000 * 86_400, 50 + i % 10)
    elapsed = time.perf_counter() - started
    total = store.stats(["a:8073"], "ham-40m", 20_000 * 86_400).result(5)["a:8073"].count
    store.close()
    assert total == 500
    assert elapsed < 0.5


# --- Sampler ---


class Recorder:
    def __init__(self):
        self.samples = []

    def add(self, receiver, band, at_s, level):
        self.samples.append((receiver, band, level))


def test_one_sample_per_receiver_and_band_per_interval():
    rec, mono = Recorder(), Clock(1_000.0)
    sampler = NoiseSampler(rec, monotonic=mono, wall=Clock(0.0))
    f = frame(start_khz=7_090.0)  # 40m and 41m
    assert sampler.offer("a:8073", f, 0.0) == 2
    assert sampler.offer("a:8073", f, 0.0) == 0
    assert sampler.offer("b:8073", f, 0.0) == 2  # another receiver counts on its own
    mono.t += SAMPLE_INTERVAL_S - 1
    assert sampler.offer("a:8073", f, 0.0) == 0
    mono.t += 1
    assert sampler.offer("a:8073", f, 0.0) == 2
    assert {s[1] for s in rec.samples} == {"ham-40m", "bc-41m"}
    assert len(rec.samples) == 6


def test_overflow_and_other_zooms_give_no_sample():
    rec = Recorder()
    sampler = NoiseSampler(rec, monotonic=Clock(), wall=Clock())
    assert sampler.offer("a:8073", frame(start_khz=7_090.0), 0.0, overflow=True) == 0
    assert sampler.offer("a:8073", frame(start_khz=7_090.0, zoom=5, span_khz=938), 0.0) == 0
    assert rec.samples == []
    # Not throttled by those: the next good frame is kept.
    assert sampler.offer("a:8073", frame(start_khz=7_090.0), 0.0) == 2


def test_a_frame_outside_every_band_gives_nothing():
    rec = Recorder()
    sampler = NoiseSampler(rec, monotonic=Clock(), wall=Clock())
    assert sampler.offer("a:8073", frame(start_khz=8_000.0), 0.0) == 0


async def test_a_sweep_hands_every_frame_to_the_sampler():
    seen = []

    async def fetch(zoom, cf):
        return frame(start_khz=cf - 30_000 / 2**zoom / 2, span_khz=30_000 / 2**zoom, zoom=zoom)

    await sweep(fetch, on_frame=seen.append)
    assert len(seen) > 14 and any(f.zoom == NOISE_ZOOM for f in seen)


# --- Sessions: sampled from the live view, not after an overflow ---


def _view_and_wait(kiwi_kw, wait_s=1.5):
    def body(kiwi):
        app = create_app(settings())
        client = TestClient(app)
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port, freq=7_150, mode="lsb"))
            until_state(ws, "listening")
            ws.send_text('{"type": "view", "id": 1, "zoom": 6, "cfKhz": 7150}')
            deadline = time.monotonic() + wait_s
            while time.monotonic() < deadline:
                ws.receive()
            key = f"127.0.0.1:{kiwi.port}"
            return key, app.state.noise_store.stats([key], "ham-40m").result(5)

    return run_with_fake(body, **kiwi_kw)


@pytest.mark.timeout(20)
def test_a_live_view_at_the_sample_zoom_is_sampled():
    key, stats = _view_and_wait({"wf_bins": lambda start, span: np.full(1024, 77, dtype=np.uint8)})
    assert stats[key].median_db == 77 and stats[key].count == 1


@pytest.mark.timeout(20)
def test_a_receiver_whose_adc_overflows_isnt_sampled():
    key, stats = _view_and_wait({"adc_overflow": True})
    assert key not in stats


# --- GET /noise ---


def test_parse_receivers():
    assert parse_receivers("A.Example:8073, b.example:8074,a.example:8073") == ["a.example:8073", "b.example:8074"]
    for bad in (None, "", "a.example", "a.example:0", "a.example:99999", ":8073", "a b:8073", "a:80x", "a:8073,"):
        assert parse_receivers(bad) is None, bad
    assert parse_receivers(",".join(f"r{i}:8073" for i in range(NOISE_MAX_RECEIVERS))) is not None
    assert parse_receivers(",".join(f"r{i}:8073" for i in range(NOISE_MAX_RECEIVERS + 1))) is None


def test_noise_endpoint_answers_with_cors_for_the_websockets_origins():
    app = create_app(settings())
    now = time.time()
    app.state.noise_store.add("a.example:8073", "ham-40m", now, 55)
    app.state.noise_store.add("a.example:8073", "ham-20m", now, 65)
    client = TestClient(app)
    r = client.get("/noise", params={"receivers": "A.example:8073,b.example:8073", "band": "ham-40m"}, headers=ORIGIN)
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == ORIGIN["origin"]
    assert r.headers["vary"] == "Origin"
    assert r.headers["cache-control"] == "public, max-age=300"
    body = r.json()
    assert body["band"] == "ham-40m" and body["hourUtc"] == utc_slot(now)[1] and body["windowDays"] == WINDOW_DAYS
    assert body["receivers"] == {"a.example:8073": {"medianDb": 55, "count": 1, "baselineDb": 60, "baselineCount": 2}}


def test_noise_endpoint_gives_no_cors_to_other_origins():
    client = TestClient(create_app(settings()))
    r = client.get("/noise", params={"receivers": "a:8073", "band": "ham-40m"}, headers={"origin": "https://evil.example"})
    assert r.status_code == 200
    assert "access-control-allow-origin" not in r.headers
    pre = client.options("/noise", headers={"origin": "https://evil.example"})
    assert "access-control-allow-origin" not in pre.headers


def test_noise_preflight_allows_get_from_the_websockets_origins():
    client = TestClient(create_app(settings()))
    r = client.options("/noise", headers={**ORIGIN, "access-control-request-method": "GET"})
    assert r.status_code == 204
    assert r.headers["access-control-allow-origin"] == ORIGIN["origin"]
    assert r.headers["access-control-allow-methods"] == "GET, OPTIONS"


def test_noise_endpoint_needs_no_token():
    client = TestClient(create_app(settings(token="secret")))
    r = client.get("/noise", params={"receivers": "a:8073", "band": "ham-40m"}, headers=ORIGIN)
    assert r.status_code == 200


@pytest.mark.parametrize(
    "params",
    [
        {"band": "ham-40m"},
        {"receivers": "a:8073"},
        {"receivers": "a:8073", "band": "40m"},
        {"receivers": "nope", "band": "ham-40m"},
        {"receivers": ",".join(f"r{i}:8073" for i in range(NOISE_MAX_RECEIVERS + 1)), "band": "ham-40m"},
        {"receivers": "a:8073", "band": "ham-40m", "extra": "1"},
    ],
)
def test_noise_endpoint_refuses_anything_else_with_400(params):
    client = TestClient(create_app(settings()))
    r = client.get("/noise", params=params, headers=ORIGIN)
    assert r.status_code == 400
    assert r.headers["access-control-allow-origin"] == ORIGIN["origin"]


def test_noise_endpoint_refuses_a_repeated_receivers_parameter():
    client = TestClient(create_app(settings()))
    r = client.get("/noise?receivers=a:8073&receivers=b:8073&band=ham-40m", headers=ORIGIN)
    assert r.status_code == 400


def test_noise_endpoint_is_get_and_options_only():
    client = TestClient(create_app(settings()))
    assert client.post("/noise").status_code == 405


# --- Deploy: the data survives redeploys, and /noise is reachable ---

REPO = Path(__file__).resolve().parents[3]


# Value: protects=the SQLite file lives on a named volume at the path the image points NOISE_DB at, in prod and dev, and Caddy proxies /noise; fails_when=the volume or mount is dropped (data lost on every deploy), NOISE_DB moves off the volume, or /noise 404s at Caddy; why_new=issue #67; seam=reads the files, no Docker run; no_claim=Docker's volume semantics
def test_the_noise_data_sits_on_a_named_volume_and_caddy_routes_noise():
    dockerfile = (REPO / "apps/radio/Dockerfile").read_text()
    path = re.search(r"^ENV NOISE_DB=(\S+)$", dockerfile, re.M)
    assert path and path.group(1).startswith("/data/")
    assert "chown radio:radio /data" in dockerfile
    for compose in ("docker-compose.prod.yml", "docker-compose.yml"):
        text = (REPO / compose).read_text()
        assert "- radio_data:/data" in text, compose
        assert re.search(r"^volumes:\n(?:  \S+:\n)*  radio_data:$", text, re.M), compose
    caddy = (REPO / "deploy/Caddyfile").read_text()
    assert re.search(r"handle /noise \{[^}]*reverse_proxy radio:8765", caddy)
