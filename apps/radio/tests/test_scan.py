import asyncio
import re
from pathlib import Path

import numpy as np
import pytest

from skywave_radio.scan import (
    HAM_CAPS,
    HAM_SEGMENTS,
    MAX_SIGNALS,
    SCAN_BANDS,
    Band,
    FramePlan,
    HamSignal,
    find_ham,
    find_peaks,
    mw_grid,
    plan_frames,
    summarize,
    summarize_ham,
    sweep,
    sweep_ham,
)
from skywave_radio.waterfall import WaterfallFrame

WEB_TYPES = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "radio-types.ts"
NOISE = 140


def frame_for(start_khz: float, span_khz: float, signals=(), blocks=()) -> WaterfallFrame:
    """A frame of flat noise with AM carriers (narrow, with weaker sidebands)
    at `signals` [(rf kHz, dB above noise)] and flat 10 kHz blocks at `blocks`."""
    bins = np.full(1024, NOISE, dtype=np.int16)
    kpb = span_khz / 1024

    def at(khz):
        return int((khz - start_khz) / kpb)

    for khz, db in signals:
        for side in (-3.0, 3.0):  # an audio tone in each sideband, 20 dB down
            i = at(khz + side)
            if 0 <= i < 1024:
                bins[i] = max(bins[i], NOISE + db - 20)
        i = at(khz)
        if 0 <= i < 1024:
            bins[i] = NOISE + db
    for khz, db in blocks:
        lo, hi = at(khz - 5), at(khz + 5)
        bins[max(lo, 0) : max(min(hi, 1024), 0)] = NOISE + db
    return WaterfallFrame(zoom=6, start_khz=start_khz, span_khz=span_khz, bins=np.clip(bins, 0, 255).astype(np.uint8))


def plan(name="31m", lo=9400.0, hi=9900.0, zoom=6) -> FramePlan:
    return FramePlan(Band(name, lo, hi, zoom), (lo + hi) / 2, lo, hi)


# Value: protects=the scan's shortwave bands stay the dial's broadcast bands (D8 mirror); fails_when=either table changes alone; why_new=two copies across languages; seam=none; no_claim=MW, which only the scan has
def test_scan_bands_mirror_the_dials_broadcast_bands():
    web = re.search(r"BROADCAST_BANDS: Band\[\] = \[(.*?)\];", WEB_TYPES.read_text(), re.S)
    assert web
    dial = re.findall(r'name: "(\w+)", startKhz: (\d+), endKhz: (\d+)', web.group(1))
    scan = [(b.name, str(int(b.start_khz)), str(int(b.end_khz))) for b in SCAN_BANDS if b.name != "MW"]
    assert scan == dial


# Value: protects=a sweep is about 19 frames and every band is covered; fails_when=a wide band gets one frame and loses its edges, or frames multiply; why_new=no sweep code; seam=none; no_claim=sweep time on a real Kiwi
def test_frames_cover_every_band_within_their_span():
    plans = plan_frames()
    assert len(plans) == 19
    for band in SCAN_BANDS:
        mine = [p for p in plans if p.band == band]
        span = 30_000 / 2**band.zoom
        assert min(p.cf_khz - span / 2 for p in mine) <= band.start_khz
        assert max(p.cf_khz + span / 2 for p in mine) >= band.end_khz
    assert sum(p.band.name in ("MW", "31m", "25m", "19m") for p in plans) == 8


# Value: protects=a receiver behind a converter is swept in its own baseband and only where it covers (D15); fails_when=offset ignored or coverage not clipped; why_new=Codex O5; seam=none; no_claim=real converter setups
def test_frames_follow_the_receivers_offset_and_coverage():
    plans = plan_frames(offset_khz=5_000.0, bandwidth_khz=10_000.0)
    names = {p.band.name for p in plans}
    assert "MW" not in names and "90m" not in names  # below 5,000 kHz
    assert "19m" not in names  # above 15,000 kHz
    p60 = next(p for p in plans if p.band.name == "60m")  # 4,750-5,060: only its top is covered
    assert (p60.lo_khz, p60.hi_khz) == (5_000.0, 5_060.0)
    assert "49m" in names and "22m" in names
    # The Kiwi takes baseband: 49m's frames run from 900 to 1,200 kHz on this receiver.
    span = 10_000.0 / 2**6
    f49 = [p for p in plans if p.band.name == "49m"]
    assert min(p.cf_khz - span / 2 for p in f49) == pytest.approx(5_900.0 - 5_000.0)
    assert max(p.cf_khz + span / 2 for p in f49) == pytest.approx(6_200.0 - 5_000.0)
    assert plan_frames(offset_khz=100_000.0, bandwidth_khz=30_000.0) == []


# Value: protects=every frame lies inside the receiver's coverage, including a band clipped at either edge into a single frame, so a Kiwi can show exactly what was asked (adversarial P1, Codex + Claude); fails_when=the single-frame centre is the clipped band's midpoint, which hangs off the edge, never matches and stalls the scan 10 s; why_new=Step 11 structured review; seam=none; no_claim=how a real Kiwi clamps
@pytest.mark.parametrize("offset,bandwidth", [(5_000.0, 10_000.0), (2_400.0, 30_000.0), (0.0, 9_620.0), (0.0, 30_000.0)])
def test_every_frame_fits_the_receivers_coverage(offset, bandwidth):
    plans = plan_frames(offset_khz=offset, bandwidth_khz=bandwidth)
    for p in plans:
        span = bandwidth / 2**p.band.zoom
        assert p.cf_khz - span / 2 >= -1e-9, p
        assert p.cf_khz + span / 2 <= bandwidth + 1e-9, p
        if sum(q.band is p.band for q in plans) == 1:
            # A one-frame band's covered part is still all inside the frame.
            assert p.cf_khz + offset - span / 2 <= p.lo_khz + 1e-9 and p.hi_khz <= p.cf_khz + offset + span / 2 + 1e-9


# Value: protects=carriers are found at their frequency, measured above the median noise; fails_when=floor or bin-to-kHz mapping is wrong; why_new=no peak code; seam=none; no_claim=real waterfall dB scale
def test_finds_carriers_above_the_noise():
    frame = frame_for(9_416.0, 468.75, signals=[(9_420.0, 30), (9_670.0, 45)])
    peaks = [p for p in find_peaks(frame, plan()) if p.snr_db >= 30]
    assert [round(p.freq_khz) for p in sorted(peaks, key=lambda p: p.freq_khz)] == [9_420, 9_670]
    assert max(p.snr_db for p in peaks) == 45


# Value: protects=a station's sidebands aren't listed as stations next to it; fails_when=sideband tones become 7362/7368-style entries (seen in the T1 spike); why_new=spike data; seam=none; no_claim=stations closer than 4.6 kHz
def test_sidebands_are_not_separate_stations():
    frame = frame_for(9_416.0, 468.75, signals=[(9_500.0, 40)])
    result = summarize(find_peaks(frame, plan()), 1, 1)
    assert [s["freqKhz"] for s in result.signals] == [9_500.0]


# Value: protects=flat-topped digital or noise signals are left out and counted (D18); fails_when=a 10 kHz block is listed, or dropped silently; why_new=user asked about "louder, not voices"; seam=none; no_claim=real DRM spectra (synthetic block)
def test_flat_blocks_are_counted_not_listed():
    frame = frame_for(9_416.0, 468.75, signals=[(9_600.0, 25)], blocks=[(9_700.0, 35)])
    result = summarize(find_peaks(frame, plan()), 1, 1)
    assert [s["freqKhz"] for s in result.signals] == [9_600.0]
    assert result.hidden == 1


# Value: protects=shortwave on 5 kHz, MW on the grid its carriers fit (D7); fails_when=MW snaps to 5 kHz or to the wrong region's grid; why_new=Section 2 C1; seam=none; no_claim=receivers hearing both grids equally
@pytest.mark.parametrize(
    "mw,grid",
    [([693.3, 909.6, 1088.7], 9.0), ([710.4, 1009.6, 1219.8], 10.0), ([], 9.0)],
    ids=["Europe", "Americas", "no MW"],
)
def test_medium_wave_snaps_to_the_grid_it_fits(mw, grid):
    assert mw_grid(mw) == grid


# Value: protects=the summary snaps MW and shortwave carriers to their channels together (D7); fails_when=summarize stops snapping or uses one grid for both; why_new=mw_grid is tested alone above; seam=none; no_claim=real spectra (synthetic peaks)
def test_snapping_in_the_summary():
    mw = frame_for(530.0, 937.5, signals=[(693.3, 30), (909.6, 25)])
    sw = frame_for(9_416.0, 468.75, signals=[(9_419.6, 30)])
    peaks = find_peaks(mw, plan("MW", 530, 1700, 5)) + find_peaks(sw, plan())
    freqs = {s["freqKhz"] for s in summarize(peaks, 2, 2).signals}
    assert {693.0, 909.0, 9_420.0} <= freqs


# Value: protects=the list is capped and ranked strongest first; fails_when=order or cap breaks; why_new=no ranking; seam=none; no_claim=none beyond protects
def test_ranked_strongest_first_and_capped():
    signals = [(9_420.0 + 10 * i, 20 + i) for i in range(30)]
    frame = frame_for(9_416.0, 468.75, signals=signals)
    result = summarize(find_peaks(frame, plan()), 1, 1)
    assert len(result.signals) == MAX_SIGNALS
    snrs = [s["snrDb"] for s in result.signals]
    assert snrs == sorted(snrs, reverse=True)


# Value: protects=a slow receiver yields the bands finished before 15 s, marked partial (D10); fails_when=the deadline drops results or never fires; why_new=Jakarta took 15 s in the spike; seam=deadline_s (the sweep's own parameter); no_claim=real timing
async def test_sweep_stops_at_the_deadline_with_finished_bands():
    calls = []

    async def fetch(zoom, cf):
        calls.append(cf)
        if len(calls) > 3:
            await asyncio.sleep(1)
        span = 30_000 / 2**zoom
        return frame_for(cf - span / 2, span, signals=[(cf, 30)])

    result = await sweep(fetch, deadline_s=0.3)
    assert result.partial
    assert 0 < result.bands_done < result.bands_total == 15
    assert result.signals


# Value: protects=a sweep that fetches every frame reports all 15 bands done and not partial; fails_when=band counting is off, so complete scans are shown (and not cached) as partial; why_new=only the deadline case was tested; seam=none; no_claim=real Kiwi timing
async def test_full_sweep_is_not_partial():
    async def fetch(zoom, cf):
        span = 30_000 / 2**zoom
        return frame_for(cf - span / 2, span)

    result = await sweep(fetch)
    assert not result.partial
    assert (result.bands_done, result.bands_total) == (15, 15)
    assert result.signals == [] and result.hidden == 0


# Value: protects=carriers just outside a narrow band, inside the same frame, aren't listed under it; fails_when=the in-band check goes, so 75m lists its neighbours; why_new=every frame before sat inside its band; seam=none; no_claim=none beyond protects
def test_peaks_outside_the_band_are_ignored():
    frame = frame_for(3_716.0, 468.75, signals=[(3_800.0, 40), (3_950.0, 30)])
    peaks = find_peaks(frame, plan("75m", 3_900, 4_000))
    assert {round(p.freq_khz) for p in peaks if p.snr_db >= 30} == {3_950}


# Value: protects=the windowed sideband check keeps stations 5 kHz apart and drops a much weaker peak 3 kHz from a station, across frames; fails_when=the bisect window is off by one or too narrow or wide; why_new=drop_sidebands now searches a sorted window (review D3); seam=none; no_claim=real sideband shapes
def test_sideband_window_keeps_neighbours_and_drops_sidebands():
    from skywave_radio.scan import Peak, drop_sidebands

    def peak(freq, snr):
        return Peak(freq_khz=freq, snr_db=snr, over_shoulder_db=20, width_khz=0.5, band="31m")

    kept = drop_sidebands([peak(9_500.0, 40), peak(9_505.0, 38), peak(9_503.0, 25), peak(9_496.0, 29)])
    assert sorted(p.freq_khz for p in kept) == [9_500.0, 9_505.0]


# Value: protects=a frame full of local maxima stays cheap: every peak's width walk stops just past AM_MAX_WIDTH_KHZ, so a hostile or noisy frame can't make the peak finder scan the whole frame per peak (review D3); fails_when=the walk loses its bound; why_new=security review (event-loop stall); seam=none; no_claim=wall-clock time (asserted through widths, not timing)
def test_peak_width_walk_is_bounded():
    from skywave_radio.scan import AM_MAX_WIDTH_KHZ

    # A rippled plateau 400 bins (about 180 kHz) wide on a quiet floor: about
    # 200 local maxima, each of which would otherwise walk the whole plateau.
    bins = np.full(1024, 140, dtype=np.uint8)
    bins[300:700] = 200
    bins[300:700:2] = 199
    frame = WaterfallFrame(zoom=6, start_khz=9_416.0, span_khz=468.75, bins=bins)
    peaks = find_peaks(frame, plan())
    assert len(peaks) > 100
    kpb = 468.75 / 1024
    assert max(p.width_khz for p in peaks) <= 2 * (AM_MAX_WIDTH_KHZ + 2 * kpb) + kpb


# Value: protects=a frame of hundreds of equal plateau peaks keeps only the strongest MAX_PEAKS_PER_FRAME, so the sideband check stays cheap even when a sweep's peaks crowd together (cycle-2 security); fails_when=the cap goes; why_new=security review (tiny bandwidth, quadratic drop_sidebands); seam=none; no_claim=wall-clock time
def test_peaks_per_frame_are_capped():
    from skywave_radio.scan import MAX_PEAKS_PER_FRAME

    bins = np.full(1024, 140, dtype=np.uint8)
    bins[::2] = 200  # 512 isolated peaks
    frame = WaterfallFrame(zoom=6, start_khz=9_416.0, span_khz=468.75, bins=bins)
    assert len(find_peaks(frame, plan())) == MAX_PEAKS_PER_FRAME


# --- Amateur bands ---

HAM_SPAN = 30_000 / 2**7  # 234.375 kHz at zoom 7


def ham_frame(start_khz: float, *, voices=(), carriers=(), blocks=(), cw=(), span_khz=HAM_SPAN) -> WaterfallFrame:
    """A zoom-7 frame of flat noise with amateur-shaped signals (RF kHz).

    voices: (lo, hi, dB) SSB blocks, rippled like held speech; carriers: AM
    stations (carrier plus sidebands +-4.5 kHz, 20 dB down); blocks: flat
    (lo, hi, dB) runs; cw: (kHz, dB) one-bin tones."""
    bins = np.full(1024, NOISE, dtype=np.int16)
    kpb = span_khz / 1024

    def at(khz):
        return int((khz - start_khz) / kpb)

    for lo, hi, db in voices:
        for i in range(max(at(lo), 0), min(at(hi), 1024)):
            bins[i] = NOISE + db - (i % 3) * 2  # speech under max-hold: uneven, no carrier
    for lo, hi, db in blocks:
        bins[max(at(lo), 0) : min(at(hi), 1024)] = NOISE + db
    for khz, db in carriers:
        for i in range(at(khz - 4.5), at(khz + 4.5)):
            if 0 <= i < 1024:
                bins[i] = max(bins[i], NOISE + db - 20)
        bins[at(khz)] = NOISE + db
    for khz, db in cw:
        bins[at(khz)] = NOISE + db
    return WaterfallFrame(zoom=7, start_khz=start_khz, span_khz=span_khz, bins=np.clip(bins, 0, 255).astype(np.uint8))


def ham_plan(name: str, kind: str) -> FramePlan:
    band = next(b for b in HAM_SEGMENTS if b.name == name and b.kind == kind)
    return FramePlan(band, (band.start_khz + band.end_khz) / 2, band.start_khz, band.end_khz)


# Value: protects=the amateur segments stay inside the dial's HAM_BANDS, split once per band at its CW/phone edge (D12 mirror); fails_when=either table changes alone or a segment drifts out of its band; why_new=two copies across languages; seam=none; no_claim=other regions' exact sub-band edges
def test_ham_segments_tile_the_dials_ham_bands():
    web = re.search(r"HAM_BANDS: Band\[\] = \[(.*?)\];", WEB_TYPES.read_text(), re.S)
    assert web
    rows = re.findall(r'name: "(\w+)", startKhz: (\d+), endKhz: (\d+)', web.group(1))
    dial = {name: (int(lo), int(hi)) for name, lo, hi in rows}
    by_band: dict[str, list[Band]] = {}
    for seg in HAM_SEGMENTS:
        by_band.setdefault(seg.name, []).append(seg)
    assert set(by_band) == set(dial)
    for name, segs in by_band.items():
        lo, hi = dial[name]
        assert segs[0].start_khz == lo and segs[0].kind == "cw", name
        assert all(a.end_khz == b.start_khz for a, b in zip(segs, segs[1:])), name
        # 10m phone stops at 29,000: above it is FM and satellites.
        assert segs[-1].end_khz == (29_000 if name == "10m" else hi), name
    assert [s.kind for s in by_band["30m"]] == ["cw"]
    assert len(plan_frames(bands=HAM_SEGMENTS)) == 23  # 13 phone + 10 CW/digital (D13)


# Value: protects=a USB voice tunes its dial (the block's low edge less 0.3 kHz) within 0.3 kHz and an LSB voice its high edge plus 0.3 (D5); fails_when=the edge sign, the offset or the mode by frequency flips; why_new=no ham detector; seam=none; no_claim=real speech or filter widths (spike fixtures cover it)
@pytest.mark.parametrize(
    "name,dial,mode,lo,hi",
    [("20m", 14_251.3, "usb", 14_251.6, 14_254.0), ("40m", 7_188.0, "lsb", 7_185.3, 7_187.7)],
)
def test_ssb_voices_tune_their_dial(name, dial, mode, lo, hi):
    band = next(b for b in HAM_SEGMENTS if b.name == name and b.kind == "phone")
    start = band.start_khz
    found = find_ham(ham_frame(start, voices=[(lo, hi, 25)]), ham_plan(name, "phone"))
    assert len(found) == 1
    sig = found[0]
    assert (sig.kind, sig.mode, sig.band) == ("voice", mode, name)
    assert sig.freq_khz == pytest.approx(dial, abs=0.3)


# Value: protects=an AM broadcaster in a shared segment (Europe's 7.2-7.3 MHz) and blocks of the wrong width are not listed as voices (finding 8); fails_when=the carrier or width checks go; why_new=no ham detector; seam=none; no_claim=every broadcaster shape (synthetic AM)
def test_carriers_and_wrong_widths_are_not_voices():
    start = 7_060.0
    frame = ham_frame(start, carriers=[(7_250.0, 40)], blocks=[(7_100.0, 7_106.0, 25), (7_150.0, 7_150.5, 25)])
    assert [s for s in find_ham(frame, ham_plan("40m", "phone")) if s.kind == "voice"] == []


# Value: protects=a narrow tone in a CW segment lists as Morse at its own frequency, tuned in cw (the service adds the pitch, session.kiwi_freq_khz); fails_when=CW is read as voice, or its frequency moves; why_new=D12; seam=none; no_claim=keying speed (one held snapshot)
def test_cw_tones_list_at_their_frequency():
    found = find_ham(ham_frame(14_000.0, cw=[(14_025.4, 22)]), ham_plan("20m", "cw"))
    assert [(s.kind, s.mode) for s in found] == [("cw", "cw")]
    assert found[0].freq_khz == pytest.approx(14_025.4, abs=0.25)


# Value: protects=activity in an FT8/FT4 window is a digital row at the standard dial, even inside a phone segment (7074) (D12); fails_when=windows are checked after the segment kind, so 7074 lists as a voice; why_new=D12; seam=none; no_claim=decoding (none is done)
@pytest.mark.parametrize(
    "name,kind,start,dial", [("20m", "cw", 14_000.0, 14_074.0), ("40m", "phone", 7_060.0, 7_074.0)]
)
def test_digital_windows_win_over_the_segment(name, kind, start, dial):
    frame = ham_frame(start, blocks=[(dial + 0.3, dial + 2.8, 27)])
    found = find_ham(frame, ham_plan(name, kind))
    assert [(s.kind, s.label, s.freq_khz, s.mode) for s in found] == [("digital", "FT8", dial, "usb")]


# Value: protects=one voice seen by two overlapping frames is one row, groups are capped and strongest first (O4, D14); fails_when=duplicates fill the top 10 or a cap is missed; why_new=overlapping zoom-7 frames; seam=none; no_claim=none beyond protects
def test_ham_summary_merges_caps_and_ranks():
    voices = [HamSignal("voice", 14_200.0 + 4 * i, 10 + i, "20m", "usb") for i in range(14)]
    dupe = HamSignal("voice", 14_200.2, 5, "20m", "usb")
    cws = [HamSignal("cw", 14_010.0 + i, 12 + i, "20m", "cw") for i in range(8)]
    ft8 = [HamSignal("digital", 14_074.0, snr, "20m", "usb", "FT8") for snr in (20, 27)]
    result = summarize_ham(voices + [dupe] + cws + ft8, 9, 9)
    assert len(result.voice) == HAM_CAPS["voice"] and len(result.cw) == HAM_CAPS["cw"]
    assert [r["snrDb"] for r in result.voice] == sorted((r["snrDb"] for r in result.voice), reverse=True)
    assert 14_200.2 not in [r["freqKhz"] for r in result.voice]
    assert result.digital == [{"freqKhz": 14_074.0, "snrDb": 27, "band": "20m", "mode": "usb", "label": "FT8"}]
    assert not result.partial


# Value: protects=phone frames are held and CW/digital frames take one snapshot (D13), and a deadline in the ham pass returns the bands done, marked partial; fails_when=the hold/fetch split flips or the deadline drops results; why_new=no ham sweep; seam=deadline_s and hold_s (the sweep's own parameters); no_claim=real Kiwi timing (the spike measures it)
async def test_ham_sweep_holds_phone_and_stops_at_the_deadline():
    held, fetched = [], []

    async def fetch(zoom, cf):
        fetched.append(cf)
        return ham_frame(cf - HAM_SPAN / 2)

    async def hold(zoom, cf, seconds):
        held.append((cf, seconds))
        return ham_frame(cf - HAM_SPAN / 2)

    full = await sweep_ham(fetch, hold, hold_s=0.5)
    assert (len(held), len(fetched)) == (13, 10)
    assert {s for _, s in held} == {0.5}
    assert (full.bands_done, full.bands_total, full.partial) == (9, 9, False)

    async def slow_hold(zoom, cf, seconds):
        await asyncio.sleep(1)
        return ham_frame(cf - HAM_SPAN / 2)

    cut = await sweep_ham(fetch, slow_hold, deadline_s=0.2)
    assert cut.partial and cut.bands_total == 9 and cut.bands_done < 9


# Value: protects=the spike recorder saves each frame's band edges clipped to the receiver's coverage, as the service's plan_frames sees them, so eval_ham judges what the service would (review); fails_when=the recorder saves the full band edges again; why_new=review found the mismatch; seam=HOLD_S shortened for speed; no_claim=real receivers' coverage reports
async def test_the_spike_recorder_saves_clipped_band_edges(tmp_path, monkeypatch):
    import sys as _sys

    from .fakekiwi import FakeKiwi

    scripts = Path(__file__).resolve().parents[1] / "scripts"
    _sys.path.insert(0, str(scripts))
    try:
        import record_ham
    finally:
        _sys.path.remove(str(scripts))
    from skywave_radio.kiwi import KiwiClient
    from skywave_radio.waterfall import WaterfallClient

    monkeypatch.setattr(record_ham, "HOLD_S", 0.01)
    # Covers 0-28,500 kHz: 10m's CW segment is whole, its phone segment cut at 28,500.
    async with FakeKiwi(bandwidth_khz=28_500.0) as kiwi:
        snd = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
        await snd.tune(14_250.0)
        await snd.connect()
        wf = WaterfallClient("127.0.0.1", kiwi.port, timeout_s=3, timestamp=snd.timestamp)
        await wf.connect()
        try:
            await record_ham.one_round(snd, wf, tmp_path, 1)
        finally:
            await wf.close()
            await snd.close()
    segs = [str(s).split("|") for s in np.load(tmp_path / "round-01.npz")["segment"]]
    ten = [s for s in segs if s[0] == "10m" and s[1] == "phone"]
    assert ten and all(float(s[3]) == 28_500.0 for s in ten)
