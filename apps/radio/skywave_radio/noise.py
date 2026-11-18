"""Each receiver's noise floor per band and UTC hour, measured from waterfall
frames we already pull (issue #67).

Passive by design: samples come only from band-scan sweeps and live wide views,
never from a connection opened to measure, since each connection takes one of
a volunteer's channels.

* noise_floor() is one statistic per frame: a low percentile of the bins in a
  band, which ignores carriers and signals sitting on top of the noise.
* NoiseSampler decides which frames to keep: at most one per receiver and band
  every SAMPLE_INTERVAL_S, none while the receiver's ADC overflows, and only at
  NOISE_ZOOM.
* NoiseStore keeps, per receiver, band, UTC hour and UTC day, a histogram of
  whole-dB levels in SQLite, on its own thread: the loop that streams everyone's
  audio never waits on the disk. Raw samples aren't kept. Reads give the median
  and count over the last WINDOW_DAYS.

Kiwi waterfall levels are only roughly dBm and the offset differs by receiver,
so levels here are the waterfall's own steps (about 1 dB each), and a receiver
is best compared against itself: GET /noise returns its median across all
bands beside the one for the band and hour asked about.
"""

from __future__ import annotations

import concurrent.futures
import logging
import math
import queue
import sqlite3
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

import numpy as np

from .waterfall import WaterfallFrame

log = logging.getLogger(__name__)

# The share of a band's bins at or below the noise floor. Low enough that
# carriers and busy channels (often most of a broadcast band by day) sit above
# it, high enough not to land on the odd dropped bin.
NOISE_PERCENTILE = 20.0
# Fewer bins than this in a band (it barely overlaps the frame) give no sample:
# a percentile of a handful of bins is mostly one signal or one gap.
MIN_NOISE_BINS = 32
# Bins at 0 are blank (a frame part-filled at an edge of the receiver's
# coverage), not a quiet band: left out before the percentile.
BLANK_BIN = 0
# Samples are kept only at this zoom (about 0.46 kHz a bin, the one band-scan
# sweeps use). A bin's level depends on how much spectrum it covers, so mixing
# zooms would make a receiver's samples disagree with each other.
NOISE_ZOOM = 6
# At most one sample per receiver and band this often.
SAMPLE_INTERVAL_S = 600.0
# Frames within this long of an ADC overflow on the receiver's audio aren't
# sampled: an overloaded front end raises everything.
OVERFLOW_HOLD_S = 2.0
# The rolling window the medians cover.
WINDOW_DAYS = 30
# Receiver/band pairs the sampler remembers before forgetting those whose
# interval has passed.
THROTTLE_MAX = 10_000
# Samples waiting for the writer. Past this they are dropped (and logged):
# better a lost sample than a growing queue.
QUEUE_MAX = 1_000
# Samples the writer commits together at most.
BATCH_MAX = 200
# How long closing waits to queue its stop, then again for the thread, at
# shutdown. Runs after the server's own shutdown waits, inside the container's
# 40 s stop period (docker-compose.yml), so it stays short; the thread is a
# daemon, and a sample or two lost at exit doesn't matter.
CLOSE_TIMEOUT_S = 1.0


@dataclass(frozen=True)
class NoiseBand:
    id: str  # what GET /noise takes as band=
    start_khz: float
    end_khz: float


# The bands the dial knows: BROADCAST_BANDS and HAM_BANDS in
# apps/web/src/lib/radio-types.ts (keep in step, with noise-rank.ts's ids).
# Prefixed because both lists have a "15m".
NOISE_BANDS: tuple[NoiseBand, ...] = tuple(
    [
        NoiseBand(f"bc-{name}", lo, hi)
        for name, lo, hi in (
            ("120m", 2300, 2495),
            ("90m", 3200, 3400),
            ("75m", 3900, 4000),
            ("60m", 4750, 5060),
            ("49m", 5900, 6200),
            ("41m", 7200, 7450),
            ("31m", 9400, 9900),
            ("25m", 11600, 12100),
            ("22m", 13570, 13870),
            ("19m", 15100, 15800),
            ("16m", 17480, 17900),
            ("15m", 18900, 19020),
            ("13m", 21450, 21850),
            ("11m", 25670, 26100),
        )
    ]
    + [
        NoiseBand(f"ham-{name}", lo, hi)
        for name, lo, hi in (
            ("160m", 1800, 2000),
            ("80m", 3500, 4000),
            ("40m", 7000, 7300),
            ("30m", 10100, 10150),
            ("20m", 14000, 14350),
            ("17m", 18068, 18168),
            ("15m", 21000, 21450),
            ("12m", 24890, 24990),
            ("10m", 28000, 29700),
        )
    ]
)
BAND_IDS = frozenset(b.id for b in NOISE_BANDS)


def noise_floor(frame: WaterfallFrame, lo_khz: float, hi_khz: float, *, offset_khz: float = 0.0) -> float | None:
    """The NOISE_PERCENTILE of the frame's bins whose centres fall in lo..hi kHz (RF).

    offset_khz is the receiver's (RF = baseband + offset), as in scan.find_peaks.
    None when fewer than MIN_NOISE_BINS non-blank bins are in range.
    """
    n = frame.bins.size
    if n == 0 or frame.span_khz <= 0:
        return None
    khz_per_bin = frame.span_khz / n
    start = offset_khz + frame.start_khz
    # Bin i's centre is start + (i + 0.5) * khz_per_bin.
    first = max(0, math.ceil((lo_khz - start) / khz_per_bin - 0.5))
    last = min(n - 1, math.floor((hi_khz - start) / khz_per_bin - 0.5))
    if last < first:
        return None
    bins = frame.bins[first : last + 1]
    bins = bins[bins != BLANK_BIN]
    if bins.size < MIN_NOISE_BINS:
        return None
    return float(np.percentile(bins, NOISE_PERCENTILE))


def bands_in(lo_khz: float, hi_khz: float) -> list[NoiseBand]:
    """The bands overlapping lo..hi kHz (RF)."""
    return [b for b in NOISE_BANDS if b.start_khz < hi_khz and b.end_khz > lo_khz]


def utc_slot(at_s: float) -> tuple[int, int]:
    """(UTC day since the epoch, UTC hour) for a time.time() value."""
    day, rest = divmod(int(at_s), 86_400)
    return day, rest // 3_600


class NoiseSampler:
    """Turns waterfall frames into at most one sample per receiver and band per SAMPLE_INTERVAL_S.

    Shared by every session (like the scan cache), so two listeners on one
    receiver don't double its samples. Runs on the event loop and does no I/O:
    store.add only queues.
    """

    def __init__(
        self,
        store: NoiseStore,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
    ):
        self._store = store
        self._monotonic = monotonic
        self._wall = wall
        # When each (receiver, band) was last sampled (monotonic).
        self._last: dict[tuple[str, str], float] = {}

    def offer(self, receiver: str, frame: WaterfallFrame, offset_khz: float, *, overflow: bool = False) -> int:
        """Sample what this frame shows of each band, where due. Returns how many were kept."""
        if overflow or frame.zoom != NOISE_ZOOM:
            return 0
        now = self._monotonic()
        lo = offset_khz + frame.start_khz
        hi = lo + frame.span_khz
        kept = 0
        for band in bands_in(lo, hi):
            key = (receiver, band.id)
            last = self._last.get(key)
            if last is not None and now - last < SAMPLE_INTERVAL_S:
                continue
            level = noise_floor(frame, max(lo, band.start_khz), min(hi, band.end_khz), offset_khz=offset_khz)
            if level is None:
                continue
            self._remember(key, now)
            self._store.add(receiver, band.id, self._wall(), level)
            kept += 1
        return kept

    def _remember(self, key: tuple[str, str], now: float) -> None:
        if len(self._last) >= THROTTLE_MAX:
            self._last = {k: t for k, t in self._last.items() if now - t < SAMPLE_INTERVAL_S}
            if len(self._last) >= THROTTLE_MAX:
                # Every pair is fresh: drop the oldest half rather than grow.
                keep = sorted(self._last.items(), key=lambda kt: kt[1])[THROTTLE_MAX // 2 :]
                self._last = dict(keep)
        self._last[key] = now


def hist_median(hist: Iterable[tuple[int, int]]) -> tuple[float | None, int]:
    """(median, count) of a histogram of (level, how many); (None, 0) if empty."""
    pairs = sorted((level, n) for level, n in hist if n > 0)
    total = sum(n for _, n in pairs)
    if total == 0:
        return None, 0
    # The 0-based ranks of the middle sample(s).
    lo_rank, hi_rank = (total - 1) // 2, total // 2
    lo_val = hi_val = None
    seen = 0
    for level, n in pairs:
        if lo_val is None and lo_rank < seen + n:
            lo_val = level
        if hi_rank < seen + n:
            hi_val = level
            break
        seen += n
    assert lo_val is not None and hi_val is not None
    return (lo_val + hi_val) / 2, total


@dataclass(frozen=True)
class NoiseStats:
    median_db: float | None  # this band and UTC hour, over WINDOW_DAYS
    count: int
    baseline_db: float | None  # every band and hour, over WINDOW_DAYS
    baseline_count: int


_SCHEMA = """
CREATE TABLE IF NOT EXISTS noise_hist (
    receiver TEXT NOT NULL,
    band TEXT NOT NULL,
    hour INTEGER NOT NULL,
    day INTEGER NOT NULL,
    level INTEGER NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (receiver, band, hour, day, level)
) WITHOUT ROWID
"""

_STOP = object()


class NoiseStore:
    """Per receiver, band, UTC hour and day: how many samples landed on each whole-dB level.

    One thread owns the SQLite connection and does every write and read, so
    add() never blocks the event loop (it only queues) and stats() is awaited
    off the loop. path is a file, or ":memory:" (kept until the process ends).
    """

    def __init__(self, path: str = ":memory:", *, wall: Callable[[], float] = time.time):
        self.path = path
        self._wall = wall
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=QUEUE_MAX)
        self._dropped = 0
        self._pruned_day: int | None = None
        self._thread = threading.Thread(target=self._work, name="noise-store", daemon=True)
        self._thread.start()

    # --- Called from the event loop ---

    def add(self, receiver: str, band: str, at_s: float, level: float) -> None:
        day, hour = utc_slot(at_s)
        try:
            self._queue.put_nowait(("add", receiver, band, hour, day, round(level)))
        except queue.Full:
            self._dropped += 1
            if self._dropped == 1 or self._dropped % 100 == 0:
                log.warning("noise store is behind; %d sample(s) dropped so far", self._dropped)

    def submit(self, fn: Callable[[sqlite3.Connection], Any]) -> concurrent.futures.Future[Any]:
        """Run fn(connection) on the store's thread. Never blocks: a full queue fails the future."""
        future: concurrent.futures.Future[Any] = concurrent.futures.Future()
        try:
            self._queue.put_nowait(("call", fn, future))
        except queue.Full:
            future.set_exception(RuntimeError("noise store is behind"))
        return future

    def stats(self, receivers: list[str], band: str, at_s: float | None = None) -> concurrent.futures.Future[Any]:
        """A future of {receiver: NoiseStats} for those with any samples in the window."""
        day, hour = utc_slot(self._wall() if at_s is None else at_s)
        return self.submit(lambda conn: _read_stats(conn, receivers, band, hour, day))

    def close(self, timeout_s: float = CLOSE_TIMEOUT_S) -> None:
        """Write what's queued, then stop the thread (bounded: at most twice timeout_s)."""
        try:
            self._queue.put(_STOP, timeout=timeout_s)
        except queue.Full:
            log.warning("noise store didn't take its stop; leaving its thread")
            return
        self._thread.join(timeout_s)

    # --- The store's thread ---

    def _work(self) -> None:
        conn = sqlite3.connect(self.path)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(_SCHEMA)
            conn.commit()
            while True:
                items = [self._queue.get()]
                while len(items) < BATCH_MAX:
                    try:
                        items.append(self._queue.get_nowait())
                    except queue.Empty:
                        break
                adds = [i for i in items if i is not _STOP and i[0] == "add"]
                if adds:
                    self._write(conn, adds)
                for item in items:
                    if item is _STOP:
                        return
                    if item[0] == "call":
                        _, fn, future = item
                        if not future.set_running_or_notify_cancel():
                            continue
                        try:
                            future.set_result(fn(conn))
                        except BaseException as e:  # handed to whoever awaits it
                            future.set_exception(e)
        except Exception:
            log.exception("noise store thread crashed; samples are no longer kept")
        finally:
            conn.close()

    def _write(self, conn: sqlite3.Connection, adds: list[tuple[Any, ...]]) -> None:
        try:
            with conn:
                conn.executemany(
                    "INSERT INTO noise_hist (receiver, band, hour, day, level, n) VALUES (?, ?, ?, ?, ?, 1) "
                    "ON CONFLICT (receiver, band, hour, day, level) DO UPDATE SET n = n + 1",
                    [a[1:] for a in adds],
                )
                today = max(a[4] for a in adds)
                if self._pruned_day != today:
                    conn.execute("DELETE FROM noise_hist WHERE day <= ?", (today - WINDOW_DAYS,))
                    self._pruned_day = today
        except sqlite3.Error:
            log.exception("couldn't write %d noise sample(s)", len(adds))


def _read_stats(conn: sqlite3.Connection, receivers: list[str], band: str, hour: int, today: int) -> dict[str, NoiseStats]:
    oldest = today - WINDOW_DAYS + 1
    out: dict[str, NoiseStats] = {}
    for receiver in receivers:
        here = conn.execute(
            "SELECT level, SUM(n) FROM noise_hist WHERE receiver = ? AND band = ? AND hour = ? AND day >= ? "
            "GROUP BY level",
            (receiver, band, hour, oldest),
        ).fetchall()
        everywhere = conn.execute(
            "SELECT level, SUM(n) FROM noise_hist WHERE receiver = ? AND day >= ? GROUP BY level",
            (receiver, oldest),
        ).fetchall()
        median, count = hist_median(here)
        baseline, baseline_count = hist_median(everywhere)
        if baseline_count:
            out[receiver] = NoiseStats(median, count, baseline, baseline_count)
    return out
