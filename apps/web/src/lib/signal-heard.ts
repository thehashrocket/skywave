/**
 * "Last heard" for the Signal stations panel (issue #102): when listeners
 * last said they heard each station, from the "Did you hear it?" answers
 * (#101, ReceptionReport rows with txKind "signal"). The database sums the
 * answers per station (signals.lastHeard), so a flood of answers about one
 * station can't push another station's latest "heard" out of the read; this
 * file turns those sums into badges. Pure: the server passes the sums and the
 * time, so tests need no database or clock.
 */

import { formatWait } from "./ghostnet";
import { onKhz } from "./signal-panel";
import { SIGNAL_STATIONS, type SignalStation } from "./signal-stations";

const HOUR = 60 * 60_000;

/** A "heard" older than this shows no badge (#102 acceptance). */
export const HEARD_SHOWN_MS = 7 * 24 * HOUR;
/** The answer counts cover this long. */
export const COUNT_MS = 24 * HOUR;

/** A channel two or more live stations share (WWV and WWVH on 2.5, 5, 10 and 15 MHz), and who's on it. */
export type SharedChannel = { khz: number; stations: readonly SignalStation[] };

/** The channels live stations share, each once, in catalog order. */
export function sharedChannels(stations: readonly SignalStation[] = SIGNAL_STATIONS): SharedChannel[] {
  const live = stations.filter((s) => s.schedule.kind !== "defunct");
  const out: SharedChannel[] = [];
  for (const s of live) {
    for (const c of s.channels) {
      if (out.some((o) => onKhz(c.khz, o.khz))) continue;
      const on = live.filter((t) => t.channels.some((d) => onKhz(c.khz, d.khz)));
      if (on.length > 1) out.push({ khz: c.khz, stations: on });
    }
  }
  return out;
}

/** What signals.lastHeard reads, summed per station by the database (ms since the epoch). */
export type HeardSums = {
  /** Each station's newest "heard" in the last HEARD_SHOWN_MS, on any frequency. */
  latest: readonly { txName: string; ms: number }[];
  /** Each station's newest "heard" on each shared channel (within onKhz of `khz`), same window. */
  shared: readonly { khz: number; txName: string; ms: number }[];
  /** How many answers of each outcome named each station in the last COUNT_MS. */
  counts: readonly { txName: string; outcome: string; n: number }[];
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

/**
 * Each station's last-heard time and answer counts at `ms`, by slug. A
 * station with nothing to show (no answers in the windows) is left out, as
 * are names the catalog doesn't know or has as defunct. Counts are per named
 * station, kept apart even on shared frequencies, so the data can still tell
 * WWV's answers from WWVH's later.
 *
 * A station's newest "heard" anywhere is its own, unless a "heard" for any
 * station on a channel it shares is as new or newer: then that one shows,
 * under all their names. When its own newest is newer than every shared one,
 * it can't have been on a shared channel, so it is its alone.
 */
export function lastHeard(
  sums: HeardSums,
  ms: number,
  stations: readonly SignalStation[] = SIGNAL_STATIONS,
): Record<string, LastHeard> {
  const live = new Map(stations.filter((s) => s.schedule.kind !== "defunct").map((s) => [s.slug, s]));
  const out: Record<string, LastHeard> = {};
  const entry = (slug: string) => (out[slug] ??= { heardMs: null, either: null, heard24h: 0, notHeard24h: 0 });
  const inWindow = (t: number) => t <= ms && ms - t <= HEARD_SHOWN_MS;
  for (const c of sums.counts) {
    if (!live.has(c.txName)) continue;
    if (c.outcome === "heard") entry(c.txName).heard24h += c.n;
    else if (c.outcome === "not_heard") entry(c.txName).notHeard24h += c.n;
  }
  for (const l of sums.latest) {
    if (!live.has(l.txName) || !inWindow(l.ms)) continue;
    const e = entry(l.txName);
    if (e.heardMs === null || l.ms > e.heardMs) e.heardMs = l.ms;
  }
  for (const channel of sharedChannels(stations)) {
    const slugs = new Set(channel.stations.map((s) => s.slug));
    let newest: number | null = null;
    for (const r of sums.shared) {
      if (onKhz(r.khz, channel.khz) && slugs.has(r.txName) && inWindow(r.ms) && (newest === null || r.ms > newest))
        newest = r.ms;
    }
    if (newest === null) continue;
    const either = channel.stations.map((s) => s.name);
    for (const s of channel.stations) {
      const e = entry(s.slug);
      if (e.heardMs === null || newest >= e.heardMs) {
        e.heardMs = newest;
        e.either = either;
      }
    }
  }
  return out;
}

/** "heard 40 min ago", or "WWV or WWVH heard …" on a frequency they share; null with no heard report this week. */
export function heardText(h: LastHeard | undefined, now: number): string | null {
  // The server drops week-old answers when it reads them; a stale cached answer
  // (the database down) mustn't keep a badge past the week either.
  if (!h || h.heardMs === null || now - h.heardMs > HEARD_SHOWN_MS) return null;
  const ago = `heard ${formatWait(now - h.heardMs, false)} ago`;
  return h.either ? `${h.either.join(" or ")} ${ago}` : ago;
}

/**
 * "Possibly off the air" (#147): the reception answers over a longer window
 * than the badge's week, for the weekly freshness report. Not shown on the
 * page: a few unlucky listeners in a week of bad propagation mustn't hide a
 * station; a person reads the report and decides.
 */
export const ACTIVITY_WINDOW_MS = 60 * 24 * HOUR;
/** "not heard" answers it takes, with no "heard", to call a station suspect. */
export const SUSPECT_MIN_NOT_HEARD = 5;
/** ...from at least this many different listeners, so one person's bad receiver isn't enough. */
export const SUSPECT_MIN_LISTENERS = 3;

/** How many answers of one outcome one listener gave about one station (summed by the database). */
export type AnswerTally = { txName: string; outcome: string; listenerId: string; n: number };

/**
 * "suspect": SUSPECT_MIN_NOT_HEARD or more "not heard" answers from
 * SUSPECT_MIN_LISTENERS or more listeners, and no "heard". "quiet": no answers
 * at all (nobody listened, so no evidence either way). "ok" otherwise.
 * "no_open" answers (the receiver never opened) say nothing about the station.
 */
export type Activity = {
  status: "ok" | "quiet" | "suspect";
  heard: number;
  notHeard: number;
  /** Different listeners behind the "not heard" answers. */
  notHeardListeners: number;
};

/**
 * Whether a station's last ACTIVITY_WINDOW_MS of answers (`tallies`: any
 * stations', this one's are picked out) suggest it's gone, or null when silence
 * proves nothing: only stations on the air all the time (`always`, `dayNight`)
 * are judged. Irregular and Priyom-scheduled ones are expected to be silent
 * between transmissions; defunct ones are known to be off.
 */
export function stationActivity(station: SignalStation, tallies: readonly AnswerTally[]): Activity | null {
  const { kind } = station.schedule;
  if ((kind !== "always" && kind !== "dayNight") || station.priyom) return null;
  let heard = 0;
  let notHeard = 0;
  const listeners = new Set<string>();
  for (const t of tallies) {
    if (t.txName !== station.slug || t.n <= 0) continue;
    if (t.outcome === "heard") heard += t.n;
    else if (t.outcome === "not_heard") {
      notHeard += t.n;
      listeners.add(t.listenerId);
    }
  }
  const status =
    heard === 0 && notHeard === 0
      ? "quiet"
      : heard === 0 && notHeard >= SUSPECT_MIN_NOT_HEARD && listeners.size >= SUSPECT_MIN_LISTENERS
        ? "suspect"
        : "ok";
  return { status, heard, notHeard, notHeardListeners: listeners.size };
}
