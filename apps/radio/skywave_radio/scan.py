"""Band scan: sweep a receiver's bands with its waterfall and rank the signals.

Pure apart from sweep() and sweep_ham(), which take the frame fetchers
(WaterfallClient.frame and .hold) as arguments.

Broadcast (sweep): MW plus the 14 shortwave bands. Broadcasters sit on a
channel grid and stay on air for hours, so one snapshot ranks them well. The
list holds AM-shaped carriers ranked by dB above the frame's noise floor;
flat-topped signals (digital broadcasts, noise jammers) are counted rather
than listed. Shortwave snaps to 5 kHz; medium wave to whichever of the 9 and
10 kHz grids the scan's MW carriers fit better, since that differs by region.

Amateur (sweep_ham): the band plan does the classifying. Activity in a known
FT8/FT4 window is digital; a narrow signal in a CW segment is Morse; a 1-3.5
kHz block with no carrier in a phone segment is an SSB voice, whose dial
frequency is the block's edge (USB low edge, LSB high edge). Voices pause
between words, so phone frames are max-held for HOLD_S; CW and digital frames
take one snapshot, which keeps the whole scan inside DEADLINE_S.
"""

from __future__ import annotations

import asyncio
import bisect
import math
from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

import numpy as np

from .waterfall import WaterfallFrame


@dataclass(frozen=True)
class Band:
    name: str
    start_khz: float
    end_khz: float
    zoom: int  # the zoom it is swept at; a band wider than one frame takes several
    kind: str = "broadcast"  # or an amateur segment: "phone" or "cw" (CW and data)


# The 14 shortwave bands mirror BROADCAST_BANDS in apps/web/src/lib/radio-types.ts;
# medium wave is added here only (the dial doesn't draw it). Zoom 6 is about
# 469 kHz a frame at 0.46 kHz a bin, which separates stations on a 5 kHz grid;
# zoom 5 fits MW in two frames at 0.92 kHz a bin.
SCAN_BANDS: tuple[Band, ...] = (
    Band("MW", 530, 1700, 5),
    Band("120m", 2300, 2495, 6),
    Band("90m", 3200, 3400, 6),
    Band("75m", 3900, 4000, 6),
    Band("60m", 4750, 5060, 6),
    Band("49m", 5900, 6200, 6),
    Band("41m", 7200, 7450, 6),
    Band("31m", 9400, 9900, 6),
    Band("25m", 11600, 12100, 6),
    Band("22m", 13570, 13870, 6),
    Band("19m", 15100, 15800, 6),
    Band("16m", 17480, 17900, 6),
    Band("15m", 18900, 19020, 6),
    Band("13m", 21450, 21850, 6),
    Band("11m", 25670, 26100, 6),
)

MAX_SIGNALS = 20
# A peak counts when it stands this far above the frame's median.
MIN_SNR_DB = 15.0
# An AM carrier is narrow and stands above its sidebands 2-5 kHz out. In the
# T1 spike (4 Kiwis) AM carriers measured 0.46-1.83 kHz wide at -3 dB and
# 10.5-60 dB above that shoulder; a digital broadcast or noise jammer is a
# flat block about 10 kHz wide with nothing standing out.
AM_MAX_WIDTH_KHZ = 3.0
# The strongest peaks kept per frame. A crowded 470 kHz frame has at most
# about 90 stations 5 kHz apart; the cap bounds sideband work on hostile frames.
MAX_PEAKS_PER_FRAME = 128
AM_MIN_OVER_SHOULDER_DB = 6.0
# A peak this close to one at least SIDEBAND_DB stronger is that station's sideband.
SIDEBAND_KHZ = 4.6
SIDEBAND_DB = 10.0
# Flat-topped peaks closer than this are one hidden signal.
HIDDEN_CLUSTER_KHZ = 10.0
SW_GRID_KHZ = 5.0
MW_GRIDS_KHZ = (9.0, 10.0)
DEADLINE_S = 15.0

# Amateur segments: each band in HAM_BANDS (apps/web/src/lib/radio-types.ts),
# split at the edge between its CW/data and phone sub-bands. The phone
# segments are the union of the US and IARU Region 1 plans, so a European
# 40m (broadcasters above 7200) still gets its AM carriers rejected rather
# than listed. 30m has no phone. Zoom 7 is about 234 kHz a frame at 0.23 kHz
# a bin: fine enough to place an SSB edge within about a quarter kHz.
HAM_ZOOM = 7
HAM_SEGMENTS: tuple[Band, ...] = (
    Band("160m", 1800, 1843, HAM_ZOOM, "cw"),
    Band("160m", 1843, 2000, HAM_ZOOM, "phone"),
    Band("80m", 3500, 3600, HAM_ZOOM, "cw"),
    Band("80m", 3600, 4000, HAM_ZOOM, "phone"),
    Band("40m", 7000, 7060, HAM_ZOOM, "cw"),
    Band("40m", 7060, 7300, HAM_ZOOM, "phone"),
    Band("30m", 10100, 10150, HAM_ZOOM, "cw"),
    Band("20m", 14000, 14150, HAM_ZOOM, "cw"),
    Band("20m", 14150, 14350, HAM_ZOOM, "phone"),
    Band("17m", 18068, 18110, HAM_ZOOM, "cw"),
    Band("17m", 18110, 18168, HAM_ZOOM, "phone"),
    Band("15m", 21000, 21200, HAM_ZOOM, "cw"),
    Band("15m", 21200, 21450, HAM_ZOOM, "phone"),
    Band("12m", 24890, 24930, HAM_ZOOM, "cw"),
    Band("12m", 24930, 24990, HAM_ZOOM, "phone"),
    Band("10m", 28000, 28300, HAM_ZOOM, "cw"),
    Band("10m", 28300, 29000, HAM_ZOOM, "phone"),
)
# Standard FT8/FT4 dial frequencies (kHz, USB). Their traffic fills dial to
# dial + DIGITAL_WIDTH_KHZ; 7074 sits inside the 40m phone segment, so these
# windows are checked before the segment's kind.
DIGITAL_WINDOWS: tuple[tuple[str, float], ...] = (
    ("FT8", 1840), ("FT8", 3573), ("FT4", 3575), ("FT4", 7047.5), ("FT8", 7074),
    ("FT8", 10136), ("FT4", 10140), ("FT8", 14074), ("FT4", 14080), ("FT8", 18100),
    ("FT4", 18104), ("FT8", 21074), ("FT4", 21140), ("FT8", 24915), ("FT4", 24919),
    ("FT8", 28074), ("FT4", 28180),
)  # fmt: skip
DIGITAL_WIDTH_KHZ = 3.0
HOLD_S = 0.5
# Provisional until the ham spike (plan R6/R7): set these from labeled real
# frames and cite the measurements here, as the AM numbers above cite T1.
HAM_MIN_SNR_DB = 10.0  # a bin counts as signal this far above the frame's median
HAM_GAP_BINS = 2  # gaps this short inside one signal are bridged
SSB_MIN_WIDTH_KHZ = 1.0
SSB_MAX_WIDTH_KHZ = 3.5
# A run whose peak stands this far above most of the run has a carrier: AM, not SSB.
HAM_CARRIER_DB = 10.0
CW_MAX_WIDTH_KHZ = 0.5
# An SSB filter passes roughly 300-2700 Hz, so the voice starts this far from the dial.
SSB_EDGE_KHZ = 0.3
# Detections of one signal from overlapping frames are merged within this distance.
# (Overlapping frames place one voice within about 0.5 kHz; real neighbours
# sit 3 kHz apart or more, so 1.5 keeps them apart.)
HAM_MERGE_KHZ = {"voice": 1.5, "cw": 0.3, "digital": 0.0}
HAM_CAPS = {"voice": 10, "cw": 5, "digital": 5}


@dataclass(frozen=True)
class FramePlan:
    band: Band
    cf_khz: float  # baseband (RF minus the receiver's offset), as the Kiwi takes it
    lo_khz: float  # RF range of the band this frame looks at
    hi_khz: float


@dataclass(frozen=True)
class Peak:
    freq_khz: float  # RF
    snr_db: float
    over_shoulder_db: float
    width_khz: float
    band: str


@dataclass
class ScanResult:
    signals: list[dict] = field(default_factory=list)  # {"freqKhz", "snrDb", "band"}
    hidden: int = 0
    bands_done: int = 0
    bands_total: int = 0
    at_ms: int = 0  # when it was made, ms since the epoch

    @property
    def partial(self) -> bool:
        return self.bands_done < self.bands_total


@dataclass(frozen=True)
class HamSignal:
    kind: str  # "voice", "cw" or "digital"
    freq_khz: float  # what to tune: the SSB dial, the CW signal, the digital dial
    snr_db: float
    band: str
    mode: str  # "lsb", "usb" or "cw"
    label: str | None = None  # "FT8" or "FT4" for digital


@dataclass
class HamResult:
    voice: list[dict] = field(default_factory=list)  # {"freqKhz", "snrDb", "band", "mode"}
    cw: list[dict] = field(default_factory=list)
    digital: list[dict] = field(default_factory=list)  # plus "label"
    bands_done: int = 0
    bands_total: int = 0
    at_ms: int = 0

    @property
    def partial(self) -> bool:
        return self.bands_done < self.bands_total


def plan_frames(offset_khz: float = 0.0, bandwidth_khz: float = 30_000.0, bands=SCAN_BANDS) -> list[FramePlan]:
    """Frames covering each band, clipped to what this receiver covers.

    A receiver behind a converter covers offset..offset+bandwidth in RF;
    bands outside it are skipped.
    """
    plans = []
    for band in bands:
        lo = max(band.start_khz, offset_khz)
        hi = min(band.end_khz, offset_khz + bandwidth_khz)
        if hi <= lo:
            continue
        span = bandwidth_khz / 2**band.zoom
        if hi - lo <= span:
            # Kept inside the receiver's coverage: a Kiwi shows the nearest
            # slice it can, so a frame hanging off an edge would never match.
            centre = (lo + hi) / 2
            centres = [min(max(centre, offset_khz + span / 2), offset_khz + bandwidth_khz - span / 2)]
        else:
            n = int((hi - lo) // span) + 1
            step = (hi - lo - span) / (n - 1)
            centres = [lo + span / 2 + i * step for i in range(n)]
        plans += [FramePlan(band, c - offset_khz, lo, hi) for c in centres]
    return plans


def find_peaks(frame: WaterfallFrame, plan: FramePlan, offset_khz: float = 0.0) -> list[Peak]:
    """Local maxima at least MIN_SNR_DB above the frame's median, inside the band.

    Each peak looks only a few kHz either side (its shoulders, and its width
    up to just past AM_MAX_WIDTH_KHZ), so the work stays linear in the bins:
    this runs on the loop that streams everyone's audio.
    """
    n = frame.bins.size
    if n < 3:
        return []
    bins = frame.bins.astype(np.int16).tolist()
    khz_per_bin = frame.span_khz / n
    floor = float(np.median(frame.bins))
    near, far = math.ceil(2 / khz_per_bin), math.floor(5 / khz_per_bin)
    max_walk = math.ceil(AM_MAX_WIDTH_KHZ / khz_per_bin) + 1
    peaks = []
    for i in range(1, n - 1):
        b = bins[i]
        if b < floor + MIN_SNR_DB or b < bins[i - 1] or b < bins[i + 1]:
            continue
        freq = offset_khz + frame.start_khz + (i + 0.5) * khz_per_bin
        if not plan.lo_khz <= freq <= plan.hi_khz:
            continue
        shoulder = bins[max(0, i - far) : max(0, i - near + 1)] + bins[i + near : i + far + 1]
        width = 1
        for step in (-1, 1):
            j = i + step
            while 0 <= j < n and bins[j] >= b - 3 and abs(j - i) <= max_walk:
                width += 1
                j += step
        peaks.append(
            Peak(
                freq_khz=freq,
                snr_db=b - floor,
                over_shoulder_db=b - (float(np.median(shoulder)) if shoulder else floor),
                width_khz=width * khz_per_bin,
                band=plan.band.name,
            )
        )
    if len(peaks) > MAX_PEAKS_PER_FRAME:
        peaks = sorted(peaks, key=lambda p: -p.snr_db)[:MAX_PEAKS_PER_FRAME]
    return peaks


def is_am_carrier(peak: Peak) -> bool:
    return peak.width_khz <= AM_MAX_WIDTH_KHZ and peak.over_shoulder_db >= AM_MIN_OVER_SHOULDER_DB


def drop_sidebands(peaks: list[Peak]) -> list[Peak]:
    kept: list[Peak] = []
    # Kept peaks by frequency, so each check looks only within SIDEBAND_KHZ.
    by_freq: list[tuple[float, float]] = []
    for p in sorted(peaks, key=lambda p: -p.snr_db):
        lo = bisect.bisect_right(by_freq, (p.freq_khz - SIDEBAND_KHZ, math.inf))
        hi = bisect.bisect_left(by_freq, (p.freq_khz + SIDEBAND_KHZ, -math.inf))
        if any(snr - p.snr_db >= SIDEBAND_DB for _, snr in by_freq[lo:hi]):
            continue
        kept.append(p)
        bisect.insort(by_freq, (p.freq_khz, p.snr_db))
    return kept


def mw_grid(freqs: list[float]) -> float:
    """The MW channel spacing these carriers fit better: 9 kHz (Europe, Africa,
    Asia, Oceania) or 10 kHz (the Americas). Ties, including no peaks, go to 9."""

    def misfit(grid: float) -> float:
        return sum(abs(f - round(f / grid) * grid) for f in freqs)

    return min(MW_GRIDS_KHZ, key=misfit)


def snap(freq_khz: float, grid_khz: float) -> float:
    return round(freq_khz / grid_khz) * grid_khz


def summarize(peaks: list[Peak], bands_done: int, bands_total: int) -> ScanResult:
    peaks = drop_sidebands(peaks)
    carriers = [p for p in peaks if is_am_carrier(p)]
    grid = mw_grid([p.freq_khz for p in carriers if p.band == "MW"])
    best: dict[float, Peak] = {}
    for p in carriers:
        f = snap(p.freq_khz, grid if p.band == "MW" else SW_GRID_KHZ)
        if f not in best or p.snr_db > best[f].snr_db:
            best[f] = p
    ranked = sorted(best.items(), key=lambda fp: -fp[1].snr_db)[:MAX_SIGNALS]
    hidden = 0
    last = None
    for p in sorted((p for p in peaks if not is_am_carrier(p)), key=lambda p: p.freq_khz):
        if last is None or p.freq_khz - last > HIDDEN_CLUSTER_KHZ:
            hidden += 1
        last = p.freq_khz
    return ScanResult(
        signals=[{"freqKhz": f, "snrDb": round(p.snr_db), "band": p.band} for f, p in ranked],
        hidden=hidden,
        bands_done=bands_done,
        bands_total=bands_total,
    )


FetchFrame = Callable[[int, float], Awaitable[WaterfallFrame]]
HoldFrame = Callable[[int, float, float], Awaitable[WaterfallFrame]]


async def _sweep_bands(
    plans: list[FramePlan],
    grab: Callable[[FramePlan], Awaitable[WaterfallFrame]],
    find: Callable[[WaterfallFrame, FramePlan], list],
    deadline_s: float,
) -> tuple[list, int, int]:
    """(found, bands done, bands total) over these frames, a band at a time.

    Stops at deadline_s, or when one frame times out (a stalled waterfall),
    and keeps the bands finished so far, so a slow receiver still gives a
    (partial) list. A band counts only once all its frames are in.
    """
    by_band: dict[str, list[FramePlan]] = defaultdict(list)
    for plan in plans:
        by_band[plan.band.name].append(plan)
    found: list = []
    done = 0
    try:
        async with asyncio.timeout(deadline_s):
            for band_plans in by_band.values():
                items = []
                for plan in band_plans:
                    items += find(await grab(plan), plan)
                found += items
                done += 1
    except TimeoutError:
        pass
    return found, done, len(by_band)


async def sweep(
    fetch: FetchFrame,
    offset_khz: float = 0.0,
    bandwidth_khz: float = 30_000.0,
    *,
    deadline_s: float = DEADLINE_S,
    bands=SCAN_BANDS,
) -> ScanResult:
    """Fetch every planned broadcast frame and rank what they show (see _sweep_bands)."""
    found, done, total = await _sweep_bands(
        plan_frames(offset_khz, bandwidth_khz, bands),
        lambda p: fetch(p.band.zoom, p.cf_khz),
        lambda f, p: find_peaks(f, p, offset_khz),
        deadline_s,
    )
    return summarize(found, done, total)


def find_ham(frame: WaterfallFrame, plan: FramePlan, offset_khz: float = 0.0) -> list[HamSignal]:
    """Amateur signals in one (held) frame, inside its segment.

    One linear pass over the bins finds runs above the noise; each run is
    then classified by where it sits (a digital window, or the segment's kind)
    and by its shape. Runs, not local maxima: a held voice is spiky, and a cap
    on maxima (as find_peaks has) would chop the edges of weaker voices.
    """
    n = frame.bins.size
    if n < 3:
        return []
    bins = frame.bins.astype(np.int16)
    khz_per_bin = frame.span_khz / n
    floor = float(np.median(bins))
    above = np.flatnonzero(bins >= floor + HAM_MIN_SNR_DB)
    if above.size == 0:
        return []
    out: list[HamSignal] = []
    # Split the above-noise bins into runs, bridging short gaps.
    breaks = np.flatnonzero(np.diff(above) > HAM_GAP_BINS + 1)
    starts = np.concatenate(([0], breaks + 1))
    ends = np.concatenate((breaks, [above.size - 1]))
    base = offset_khz + frame.start_khz
    for a, b in zip(above[starts], above[ends]):
        run = bins[a : b + 1]
        peak_i = a + int(np.argmax(run))
        peak = float(bins[peak_i])
        lo, hi = base + a * khz_per_bin, base + (b + 1) * khz_per_bin
        centre = (lo + hi) / 2
        if not plan.lo_khz <= centre <= plan.hi_khz:
            continue
        snr = round(peak - floor)
        window = next((w for w in DIGITAL_WINDOWS if lo < w[1] + DIGITAL_WIDTH_KHZ and hi > w[1]), None)
        if window is not None:
            out.append(HamSignal("digital", window[1], snr, plan.band.name, "usb", window[0]))
        elif plan.band.kind == "cw":
            if hi - lo <= CW_MAX_WIDTH_KHZ:
                freq = base + (peak_i + 0.5) * khz_per_bin
                out.append(HamSignal("cw", round(freq, 1), snr, plan.band.name, "cw"))
        elif plan.band.kind == "phone":
            if not SSB_MIN_WIDTH_KHZ <= hi - lo <= SSB_MAX_WIDTH_KHZ:
                continue
            if peak - float(np.percentile(run, 75)) >= HAM_CARRIER_DB:
                continue  # a carrier: an AM broadcaster in a shared segment
            # Hams use LSB below 10 MHz and USB above (radio-types.ts guessMode).
            if centre < 10_000:
                out.append(HamSignal("voice", round(hi + SSB_EDGE_KHZ, 1), snr, plan.band.name, "lsb"))
            else:
                out.append(HamSignal("voice", round(lo - SSB_EDGE_KHZ, 1), snr, plan.band.name, "usb"))
    return out


def summarize_ham(found: list[HamSignal], bands_done: int, bands_total: int) -> HamResult:
    """Merge one signal seen by overlapping frames, then keep each group's strongest."""
    groups: dict[str, list[dict]] = {}
    for kind, cap in HAM_CAPS.items():
        kept: list[HamSignal] = []
        for sig in sorted((s for s in found if s.kind == kind), key=lambda s: -s.snr_db):
            if any(abs(k.freq_khz - sig.freq_khz) <= HAM_MERGE_KHZ[kind] for k in kept):
                continue
            kept.append(sig)
        rows = []
        for sig in kept[:cap]:
            row = {"freqKhz": sig.freq_khz, "snrDb": sig.snr_db, "band": sig.band, "mode": sig.mode}
            if sig.label:
                row["label"] = sig.label
            rows.append(row)
        groups[kind] = rows
    return HamResult(groups["voice"], groups["cw"], groups["digital"], bands_done, bands_total)


async def sweep_ham(
    fetch: FetchFrame,
    hold: HoldFrame,
    offset_khz: float = 0.0,
    bandwidth_khz: float = 30_000.0,
    *,
    deadline_s: float = DEADLINE_S,
    hold_s: float | None = None,
    segments=HAM_SEGMENTS,
) -> HamResult:
    """Sweep the amateur segments: phone frames held for hold_s (HOLD_S), the rest one frame each."""
    seconds = HOLD_S if hold_s is None else hold_s

    def grab(p: FramePlan) -> Awaitable[WaterfallFrame]:
        if p.band.kind == "phone":
            return hold(p.band.zoom, p.cf_khz, seconds)
        return fetch(p.band.zoom, p.cf_khz)

    found, done, total = await _sweep_bands(
        plan_frames(offset_khz, bandwidth_khz, segments),
        grab,
        lambda f, p: find_ham(f, p, offset_khz),
        deadline_s,
    )
    return summarize_ham(found, done, total)
