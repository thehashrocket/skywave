/**
 * The Reverse Beacon Network's daily spot file (issue #69 v2): which IBP
 * beacons RBN's skimmers heard in a UTC day. A beacon with no spot all day
 * was off the air (or heard nowhere, which comes to the same for a
 * listener), often days before NCDXF's own list says so, as when one is
 * switched off for a contest. Pure: the server fetches the file once a day
 * and keeps the counts (server/routers/beacons.ts).
 *
 * RBN posts each day's file just after midnight UTC, as a zip holding one
 * CSV: `callsign,de_pfx,de_cont,freq,band,dx,dx_pfx,dx_cont,mode,db,date,
 * speed,tx_mode`, about 600,000 spots. RBN marks IBP spots itself with mode
 * `NCDXF B`. Only those count, from the 18 beacons, within half a kHz of a
 * beacon frequency.
 *
 * Only a whole day without a spot counts as quiet: on ordinary days a
 * beacon can go unspotted for 16 hours just from propagation (checked
 * against RBN's files for 2026-11-15 and 2026-11-18). A day with few beacon
 * spots overall is RBN's own outage, so it marks nothing.
 */

import { BEACONS, IBP_BANDS_KHZ } from "./ibp";

export const RBN_DAY_URL = (day: string) => `https://data.reversebeacon.net/rbn_history/${day.replaceAll("-", "")}.zip`;

/** RBN posts a day's file just after midnight UTC; the server waits this long into the next day before asking. */
export const RBN_READY_AFTER_MS = 60 * 60_000;

/**
 * Fewer beacon spots than this in a day is RBN's own trouble (skimmers or
 * its servers down), not 18 beacons off: a normal day has 15,000 to 25,000.
 */
export const RBN_MIN_DAY_SPOTS = 2_000;

/** How far from a beacon frequency an RBN spot may be and still count (skimmers report to 0.1 kHz). */
const FREQ_TOLERANCE_KHZ = 0.5;

/** One UTC day's IBP spots: each beacon's count (all 18, in transmission order) and the total. */
export type RbnDay = { day: string; total: number; beacons: { call: string; spots: number }[] };

const DAY = 24 * 60 * 60_000;

/** A UTC day as "YYYY-MM-DD". */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The latest day whose file should be up by `ms`: yesterday from 01:00 UTC, else the day before. */
export function rbnDayFor(ms: number): string {
  return utcDay(ms - DAY - RBN_READY_AFTER_MS);
}

/** The day before `day` ("YYYY-MM-DD"). */
export function dayBefore(day: string): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) - DAY);
}

const CALLS = new Set(BEACONS.map((b) => b.call));
const COLUMNS = ["freq", "dx", "mode", "date"] as const;

/**
 * Counts each beacon's `NCDXF B` spots on `day` in RBN's CSV. Lines it can't
 * read, other modes, other callsigns, spots off the beacon frequencies and
 * spots dated another day are skipped. Throws when the header lacks a column
 * it needs (not RBN's file, or RBN changed it), so a cached day survives.
 */
export function countBeaconSpots(csv: string, day: string): RbnDay {
  let at = 0;
  const next = (): string | null => {
    if (at >= csv.length) return null;
    let end = csv.indexOf("\n", at);
    if (end < 0) end = csv.length;
    const line = csv.slice(at, end).replace(/\r$/, "");
    at = end + 1;
    return line;
  };
  const header = (next() ?? "").replace(/^﻿/, "").split(",").map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<(typeof COLUMNS)[number], number>;
  if (COLUMNS.some((c) => col[c] < 0)) throw new Error("Not RBN's spot file: missing columns.");
  const counts = new Map<string, number>();
  let total = 0;
  for (let line = next(); line !== null; line = next()) {
    // Most lines are other modes: skip them before splitting.
    if (!line.includes("NCDXF B")) continue;
    const f = line.split(",");
    if (f[col.mode]?.trim() !== "NCDXF B") continue;
    const call = f[col.dx]?.trim().toUpperCase();
    if (!call || !CALLS.has(call)) continue;
    const khz = Number(f[col.freq]);
    if (!IBP_BANDS_KHZ.some((b) => Math.abs(khz - b) <= FREQ_TOLERANCE_KHZ)) continue;
    if (!f[col.date]?.trim().startsWith(day)) continue;
    counts.set(call, (counts.get(call) ?? 0) + 1);
    total++;
  }
  return { day, total, beacons: BEACONS.map((b) => ({ call: b.call, spots: counts.get(b.call) ?? 0 })) };
}

/**
 * The beacons RBN didn't spot at all on the day, or none when the day's
 * total is too low to trust (RBN_MIN_DAY_SPOTS) or there's no day.
 */
export function quietBeacons(day: RbnDay | null | undefined): ReadonlySet<string> {
  if (!day || day.total < RBN_MIN_DAY_SPOTS) return new Set();
  return new Set(day.beacons.filter((b) => b.spots === 0).map((b) => b.call));
}
