"""Band scan: sweep a receiver's broadcast bands with its waterfall and rank the signals.

Pure apart from sweep(), which takes the frame fetcher (WaterfallClient.frame)
as an argument. Only broadcast bands are swept (MW plus the 14 shortwave bands):
broadcasters sit on a channel grid and stay on air for hours, so one snapshot
ranks them well, while ham signals come and go in seconds. The list holds
AM-shaped carriers ranked by dB above the frame's noise floor; flat-topped
signals (digital broadcasts, noise jammers) are counted rather than listed.
Shortwave snaps to 5 kHz; medium wave to whichever of the 9 and 10 kHz grids
the scan's MW carriers fit better, since that differs by region.
"""

from __future__ import annotations

import asyncio
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
AM_MIN_OVER_SHOULDER_DB = 6.0
# A peak this close to one at least SIDEBAND_DB stronger is that station's sideband.
SIDEBAND_KHZ = 4.6
SIDEBAND_DB = 10.0
# Flat-topped peaks closer than this are one hidden signal.
HIDDEN_CLUSTER_KHZ = 10.0
SW_GRID_KHZ = 5.0
MW_GRIDS_KHZ = (9.0, 10.0)
DEADLINE_S = 15.0


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
            centres = [(lo + hi) / 2]
        else:
            n = int((hi - lo) // span) + 1
            step = (hi - lo - span) / (n - 1)
            centres = [lo + span / 2 + i * step for i in range(n)]
        plans += [FramePlan(band, c - offset_khz, lo, hi) for c in centres]
    return plans


def find_peaks(frame: WaterfallFrame, plan: FramePlan, offset_khz: float = 0.0) -> list[Peak]:
    """Local maxima at least MIN_SNR_DB above the frame's median, inside the band."""
    bins = frame.bins.astype(np.int16)
    if bins.size < 3:
        return []
    khz_per_bin = frame.span_khz / bins.size
    floor = float(np.median(bins))
    peaks = []
    for i in range(1, bins.size - 1):
        if bins[i] < floor + MIN_SNR_DB or bins[i] < bins[i - 1] or bins[i] < bins[i + 1]:
            continue
        freq = offset_khz + frame.start_khz + (i + 0.5) * khz_per_bin
        if not plan.lo_khz <= freq <= plan.hi_khz:
            continue
        reach = np.abs(np.arange(bins.size) - i) * khz_per_bin
        shoulder = bins[(reach >= 2) & (reach <= 5)]
        width = 1
        for step in (-1, 1):
            j = i + step
            while 0 <= j < bins.size and bins[j] >= bins[i] - 3:
                width += 1
                j += step
        peaks.append(
            Peak(
                freq_khz=freq,
                snr_db=float(bins[i]) - floor,
                over_shoulder_db=float(bins[i]) - (float(np.median(shoulder)) if shoulder.size else floor),
                width_khz=width * khz_per_bin,
                band=plan.band.name,
            )
        )
    return peaks


def is_am_carrier(peak: Peak) -> bool:
    return peak.width_khz <= AM_MAX_WIDTH_KHZ and peak.over_shoulder_db >= AM_MIN_OVER_SHOULDER_DB


def drop_sidebands(peaks: list[Peak]) -> list[Peak]:
    kept: list[Peak] = []
    for p in sorted(peaks, key=lambda p: -p.snr_db):
        if not any(abs(p.freq_khz - k.freq_khz) < SIDEBAND_KHZ and k.snr_db - p.snr_db >= SIDEBAND_DB for k in kept):
            kept.append(p)
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


async def sweep(
    fetch: FetchFrame,
    offset_khz: float = 0.0,
    bandwidth_khz: float = 30_000.0,
    *,
    deadline_s: float = DEADLINE_S,
    bands=SCAN_BANDS,
) -> ScanResult:
    """Fetch every planned frame and rank what they show.

    Stops at deadline_s and returns the bands finished so far, so a slow
    receiver still gives a (partial) list.
    """
    by_band: dict[str, list[FramePlan]] = defaultdict(list)
    for plan in plan_frames(offset_khz, bandwidth_khz, bands):
        by_band[plan.band.name].append(plan)
    found: list[Peak] = []
    done = 0
    try:
        async with asyncio.timeout(deadline_s):
            for plans in by_band.values():
                peaks = []
                for plan in plans:
                    frame = await fetch(plan.band.zoom, plan.cf_khz)
                    peaks += find_peaks(frame, plan, offset_khz)
                # A band counts only once all its frames are in.
                found += peaks
                done += 1
    except TimeoutError:
        pass
    return summarize(found, done, len(by_band))
