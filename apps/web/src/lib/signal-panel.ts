/**
 * The Signal stations panel's rows (issue #100): which group each catalog
 * station falls in at a given time, and what its Listen would tune. Pure: the
 * panel passes the server-corrected time, Priyom's schedule (null while the
 * server has none) and the merged schedule (on-air.ts) once it has one, so tests
 * need no clock or network.
 */

import { nextTx, onAirTx, PRIYOM_ON_AIR_MS, type PriyomTx } from "./priyom-schedule";
import {
  activeChannelAt,
  nextStartAfter,
  SIGNAL_STATIONS,
  windowSpanAt,
  type SignalChannel,
  type SignalStation,
  type SlugRow,
} from "./signal-stations";

const HOUR = 60 * 60_000;

/** "Up next" looks this far ahead (#100). */
export const UP_NEXT_MS = 6 * HOUR;

export type PanelGroup = "onNow" | "upNext" | "always" | "later" | "history";

export type PanelRow = {
  station: SignalStation;
  group: PanelGroup;
  /** What Listen tunes now; null when there's nothing to tune (not on, no frequency, defunct). */
  listen: SignalChannel | null;
  /** The frequency to show when it isn't on yet (a Priyom slot's), or null. */
  shown: SignalChannel | null;
  /** On now: when it ends. Up next and later: when it starts. Null when not known. */
  atMs: number | null;
};

export type PanelGroups = {
  /** Scheduled stations inside a window or Priyom slot now, ending soonest first. */
  onNow: PanelRow[];
  /** Starting within UP_NEXT_MS, soonest first. */
  upNext: PanelRow[];
  /** On all the time: always shown, so the panel never looks empty. */
  always: PanelRow[];
  /** Scheduled later than UP_NEXT_MS, or with no time known (irregular, or Priyom's schedule missing). */
  later: PanelRow[];
  /** Off the air for good: no Listen, ever. */
  history: PanelRow[];
};

/** A station not on yet: up next when it starts within UP_NEXT_MS, else later (time unknown included). */
function upcoming(station: SignalStation, ms: number, atMs: number | null, shown: SignalChannel | null): PanelRow {
  const soon = atMs !== null && atMs - ms <= UP_NEXT_MS;
  return { station, group: soon ? "upNext" : "later", listen: null, shown, atMs };
}

/** A Priyom slot's frequency as a channel, when it has one Skywave can tune, with Priyom's listed frequency when the dial differs. */
export function txChannel(tx: PriyomTx | null): SignalChannel | null {
  if (!tx || tx.khz === null || tx.mode === null) return null;
  return { khz: tx.khz, mode: tx.mode, ...(tx.listedKhz !== undefined && { listedKhz: tx.listedKhz }) };
}

/**
 * Where each station sits at `ms`. Numbers stations (those with a Priyom
 * designator) take their times from `priyom`; a Priyom slot is on for
 * PRIYOM_ON_AIR_MS after its start, since Priyom gives no end time. A day/night
 * station's channel follows `rows` (the merged schedule, the dial's) when given,
 * so the panel and the dial name the same frequency (#168); while they load
 * (null) its row shows no frequency and no Listen, rather than the sun's guess,
 * which can be the channel off the air; with none to be had (undefined), the sun.
 */
export function panelGroups(
  ms: number,
  priyom: readonly PriyomTx[] | null,
  rows?: readonly SlugRow[] | null,
  stations = SIGNAL_STATIONS,
): PanelGroups {
  const g: PanelGroups = { onNow: [], upNext: [], always: [], later: [], history: [] };
  for (const station of stations) {
    const kind = station.schedule.kind;
    if (kind === "defunct") {
      g.history.push({ station, group: "history", listen: null, shown: null, atMs: null });
      continue;
    }
    if (kind === "always" || kind === "dayNight") {
      const ch = kind === "dayNight" && rows === null ? null : activeChannelAt(station, ms, rows ?? undefined);
      g.always.push({ station, group: "always", listen: ch, shown: ch, atMs: null });
      continue;
    }
    if (station.priyom && priyom) {
      const on = onAirTx(priyom, station.priyom, ms);
      if (on) {
        const ch = txChannel(on);
        g.onNow.push({ station, group: "onNow", listen: ch, shown: ch, atMs: on.startMs + PRIYOM_ON_AIR_MS });
        continue;
      }
      const next = nextTx(priyom, station.priyom, ms);
      const row = upcoming(station, ms, next?.startMs ?? null, txChannel(next));
      g[row.group].push(row);
      continue;
    }
    const span = windowSpanAt(station, ms);
    if (span) {
      const ch = activeChannelAt(station, ms);
      g.onNow.push({ station, group: "onNow", listen: ch, shown: ch, atMs: span.endMs });
      continue;
    }
    const row = upcoming(station, ms, nextStartAfter(station, ms), null);
    g[row.group].push(row);
  }
  const byAt = (a: PanelRow, b: PanelRow) => (a.atMs ?? Infinity) - (b.atMs ?? Infinity);
  g.onNow.sort(byAt);
  g.upNext.sort(byAt);
  g.later.sort(byAt);
  return g;
}

/** How close the dial must be to a station's frequency to count as on it (SSB tuning steps are 0.1 kHz). */
export const ON_KHZ = 0.05;

/** Whether the dial is on `khz`. */
export function onKhz(freqKhz: number, khz: number): boolean {
  return Math.abs(freqKhz - khz) <= ON_KHZ;
}
