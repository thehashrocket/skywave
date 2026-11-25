/**
 * Priyom's numbers-station schedule (#98, owner's OK 2026-11-25): the events
 * behind https://priyom.org/number-stations/station-schedule, from the same
 * JSON calendar API that page reads. Each event is one transmission: a UTC
 * start and a summary such as "E11 20167kHz USB", "V13 15388kHz USB/AM
 * [Target: East Asia]" or "M12 Search" (frequency not known yet). Events have
 * no end time. Pure: the server fetches (routers/signals.ts), the page asks
 * these functions what's on at the server-corrected time.
 *
 * Priyom.org is CC BY-NC-SA 4.0: the panel credits it and links the schedule page.
 */

import type { Mode } from "./radio-types";

export const PRIYOM_EVENTS_URL = "https://calendar2.priyom.org/events";
export const PRIYOM_SCHEDULE_PAGE = "https://priyom.org/number-stations/station-schedule";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** How many day-long slices the server asks for: a week covers twice-weekly schedules. */
export const PRIYOM_SLICES = 7;

/**
 * How long after its start a transmission counts as on the air. Priyom gives
 * no end time; most of these stations repeat every 20-30 minutes on a new
 * frequency, so 10 minutes keeps Listen inside the message rather than after it.
 * An estimate, not a published figure.
 */
export const PRIYOM_ON_AIR_MS = 10 * 60_000;

/** One scheduled transmission. `khz` and `mode` are null when Priyom has no frequency ("Search") or no mode we tune. */
export type PriyomTx = { station: string; startMs: number; khz: number | null; mode: Mode | null; summary: string };

/**
 * The URLs for the slices covering a week from `ms`: 24 hours each, starting
 * at 00:00 or 12:00 UTC, the way Priyom's own page asks, so their responses
 * can be shared by caches. A day holds about 110 events, under the API's 250 limit.
 */
export function priyomSliceUrls(ms: number): string[] {
  const start = priyomSpan(ms).fromMs;
  return Array.from({ length: PRIYOM_SLICES }, (_, i) => {
    const from = new Date(start + i * DAY).toISOString();
    const to = new Date(start + (i + 1) * DAY).toISOString();
    return `${PRIYOM_EVENTS_URL}?timeMin=${from}&timeMax=${to}`;
  });
}

/** Priyom's modes as the dial takes them: USB/AM is tuned as USB. RTTY and other data modes have none. */
function tunedMode(priyom: string): Mode | null {
  if (priyom === "USB" || priyom === "USB/AM") return "usb";
  if (priyom === "LSB") return "lsb";
  if (priyom === "AM") return "am";
  if (priyom === "CW") return "cw";
  return null;
}

// Priyom's own pattern (nextevents-20201105.js): station, then "Search" or the
// frequency, then the mode after it. A frequency marked "last used" doesn't
// follow the station directly, so it isn't taken as the schedule's.
const SUMMARY = /^([\w /-]+?) (?:Search|(\d+(?:\.\d+)?) ?kHz(?:.*?kHz)?? ([A-Z][A-Z/]+))/i;

/**
 * The transmissions in one API response (`{ items: [{ summary, start: { dateTime } }] }`).
 * An event it can't read is skipped; a response that isn't the calendar's shape throws,
 * so the server keeps its last good copy.
 */
export function parsePriyomEvents(json: unknown): PriyomTx[] {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error("Not Priyom's event list: no items.");
  const out: PriyomTx[] = [];
  for (const item of items) {
    const summary = (item as { summary?: unknown })?.summary;
    const start = (item as { start?: { dateTime?: unknown } })?.start?.dateTime;
    if (typeof summary !== "string" || typeof start !== "string") continue;
    const startMs = Date.parse(start);
    const m = SUMMARY.exec(summary.trim());
    if (!Number.isFinite(startMs) || !m) continue;
    const khz = m[2] ? Number(m[2]) : null;
    out.push({ station: m[1]!, startMs, khz, mode: khz === null ? null : tunedMode(m[3]!.toUpperCase()), summary });
  }
  return out;
}

/** Several slices as one list: in time order, an event listed in two slices kept once. */
export function mergeSlices(slices: readonly (readonly PriyomTx[])[]): PriyomTx[] {
  const seen = new Set<string>();
  const out: PriyomTx[] = [];
  for (const tx of slices.flat()) {
    const key = `${tx.startMs} ${tx.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tx);
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** The transmission of `station` on the air at `ms` (started within PRIYOM_ON_AIR_MS), the latest if two overlap. */
export function onAirTx(txs: readonly PriyomTx[], station: string, ms: number): PriyomTx | null {
  let found: PriyomTx | null = null;
  for (const tx of txs)
    if (tx.station === station && tx.startMs <= ms && ms < tx.startMs + PRIYOM_ON_AIR_MS) found = tx;
  return found;
}

/** The next transmission of `station` starting after `ms`, or null if none is listed. */
export function nextTx(txs: readonly PriyomTx[], station: string, ms: number): PriyomTx | null {
  let found: PriyomTx | null = null;
  for (const tx of txs)
    if (tx.station === station && tx.startMs > ms && (found === null || tx.startMs < found.startMs)) found = tx;
  return found;
}

/** The span a fetch made at `ms` covers: from the first slice's start to the last one's end. */
export function priyomSpan(ms: number): { fromMs: number; toMs: number } {
  const fromMs = Math.floor(ms / (12 * HOUR)) * 12 * HOUR;
  return { fromMs, toMs: fromMs + PRIYOM_SLICES * DAY };
}

export type StationChange = { station: string; added: number; removed: number; changed: number };

/**
 * What changed between two fetches, per station, over the time both cover (a
 * slot that only rolled out of or into the window isn't a change). Matched by
 * station and start time: a new frequency or mode at the same time is
 * "changed", a time only in `next` is "added", one only in `prev` "removed".
 */
export function diffSchedules(
  prev: readonly PriyomTx[],
  next: readonly PriyomTx[],
  overlap: { fromMs: number; toMs: number },
): StationChange[] {
  const inside = (t: PriyomTx) => t.startMs >= overlap.fromMs && t.startMs < overlap.toMs;
  const key = (t: PriyomTx) => `${t.station} ${t.startMs}`;
  const before = new Map(prev.filter(inside).map((t) => [key(t), t]));
  const after = new Map(next.filter(inside).map((t) => [key(t), t]));
  const byStation = new Map<string, StationChange>();
  const bump = (station: string, field: "added" | "removed" | "changed") => {
    const c = byStation.get(station) ?? { station, added: 0, removed: 0, changed: 0 };
    c[field]++;
    byStation.set(station, c);
  };
  for (const [k, t] of after) {
    const old = before.get(k);
    if (!old) bump(t.station, "added");
    else if (old.khz !== t.khz || old.mode !== t.mode) bump(t.station, "changed");
  }
  for (const [k, t] of before) if (!after.has(k)) bump(t.station, "removed");
  return [...byStation.values()].sort((a, b) => a.station.localeCompare(b.station));
}

/** "E11: 2 changed, 1 added; M12: 1 removed", for the server log. */
export function describeChanges(changes: readonly StationChange[]): string {
  return changes
    .map((c) => {
      const parts = (["changed", "added", "removed"] as const).filter((f) => c[f] > 0).map((f) => `${c[f]} ${f}`);
      return `${c.station}: ${parts.join(", ")}`;
    })
    .join("; ");
}
