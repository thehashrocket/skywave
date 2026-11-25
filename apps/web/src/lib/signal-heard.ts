/**
 * "Last heard" for the Signal stations panel (issue #102): when listeners
 * last said they heard each station, from the "Did you hear it?" answers
 * (#101, ReceptionReport rows with txKind "signal"). Pure: the server reads
 * the rows and passes the time, so tests need no database or clock.
 */

import { onKhz } from "./signal-panel";
import { SIGNAL_STATIONS, type SignalStation } from "./signal-stations";

const HOUR = 60 * 60_000;

/** A "heard" older than this shows no badge (#102 acceptance). */
export const HEARD_SHOWN_MS = 7 * 24 * HOUR;
/** The answer counts cover this long. */
export const COUNT_MS = 24 * HOUR;

/** One stored answer, as signals.lastHeard reads it. */
export type SignalAnswer = {
  /** The station's slug. */
  txName: string;
  /** The dial frequency in kHz the server checked (reports.submit), as text. */
  txDetail: string | null;
  outcome: string;
  createdAtMs: number;
};

export type LastHeard = {
  /** The latest "heard" in the last HEARD_SHOWN_MS that can be about this station, or null. */
  heardMs: number | null;
  /**
   * The stations that "heard" may have been about, in catalog order, when it
   * was on a frequency they share (WWV and WWVH on 2.5, 5, 10 and 15 MHz):
   * owner's option 1 on #102, a "heard" for either shows on both rows as
   * "WWV or WWVH heard". Null when the frequency is this station's alone.
   */
  either: string[] | null;
  /** Answers naming this station in the last COUNT_MS. */
  heard24h: number;
  notHeard24h: number;
};

/** The live stations with a channel on `khz`, in catalog order. */
function stationsOn(khz: number, stations: readonly SignalStation[]): SignalStation[] {
  return stations.filter((s) => s.schedule.kind !== "defunct" && s.channels.some((c) => onKhz(khz, c.khz)));
}

/**
 * Each station's last-heard time and answer counts at `ms`, by slug. A
 * station with nothing to show (no answers in the windows) is left out.
 * Counts are per named station, kept apart even on shared frequencies, so
 * the data can still tell WWV's answers from WWVH's later.
 */
export function lastHeard(
  answers: readonly SignalAnswer[],
  ms: number,
  stations: readonly SignalStation[] = SIGNAL_STATIONS,
): Record<string, LastHeard> {
  const bySlug = new Map(stations.map((s) => [s.slug, s]));
  const out: Record<string, LastHeard> = {};
  const entry = (slug: string) => (out[slug] ??= { heardMs: null, either: null, heard24h: 0, notHeard24h: 0 });
  for (const a of answers) {
    const station = bySlug.get(a.txName);
    if (!station || station.schedule.kind === "defunct" || a.createdAtMs > ms) continue;
    const age = ms - a.createdAtMs;
    if (age <= COUNT_MS) {
      if (a.outcome === "heard") entry(station.slug).heard24h++;
      else if (a.outcome === "not_heard") entry(station.slug).notHeard24h++;
    }
    if (a.outcome !== "heard" || age > HEARD_SHOWN_MS) continue;
    const khz = Number(a.txDetail);
    const sharing = Number.isFinite(khz) ? stationsOn(khz, stations) : [];
    // A frequency the station shares with another: the answer is credited to every
    // station on it, under all their names. Otherwise (or an unreadable frequency), its own.
    const credited = sharing.length > 1 && sharing.includes(station) ? sharing : [station];
    const either = credited.length > 1 ? credited.map((s) => s.name) : null;
    for (const s of credited) {
      const e = entry(s.slug);
      if (e.heardMs === null || a.createdAtMs > e.heardMs) {
        e.heardMs = a.createdAtMs;
        e.either = either;
      }
    }
  }
  return out;
}
