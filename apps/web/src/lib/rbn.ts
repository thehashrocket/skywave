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
 *
 * Also RBN's skimmer list (#61, owner decision D14): where each skimmer is.
 * The daily file names skimmers by callsign only, and RBN publishes their
 * grids only as a live list (status.php?t=skt, the table behind its map,
 * covering skimmers seen in the last 7 days) with no history. The server
 * saves it twice a day (server/routers/beacons.ts, from a Vercel cron) so
 * the #61 replay can place each day's spotters.
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

/** RBN's live skimmer list: an HTML table, one row per skimmer seen in the last 7 days. */
export const RBN_SKIMMERS_URL = "https://www.reversebeacon.net/cont_includes/status.php?t=skt";

/**
 * Fewer skimmers with a usable grid than this and the page is broken or not
 * the list: the 2026-11-19 list had 350, every grid valid.
 */
export const RBN_MIN_SKIMMERS = 100;

/** One skimmer as the list gives it: grid null when RBN's isn't a Maidenhead locator. */
export type Skimmer = { call: string; grid: string | null; bands: string[]; lastSeen: number };

const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
const CELL = /<td[^>]*>([\s\S]*?)<\/td>/g;
// 4, 6 or 8 characters; an 8-character (extended) square is kept to its 6-character subsquare.
const LOCATOR = /^[A-R]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)?$/;
// Each data cell links a filter on that column; checking them tells a moved
// or renamed column from a valid one, since the table has no header row.
const CELL_MARKS: [number, string][] = [
  [0, "t=de"],
  [3, "id_dxcc_de="],
  [4, "id_cont_de="],
  [5, "id_itu_z_de="],
  [6, "id_cq_z_de="],
];

const HIDDEN_SECONDS = /<b class="hide">\s*(\d+)\s*<\/b>/;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A cell's text: tags dropped, HTML entities decoded, spaces collapsed. */
const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
      if (!dec && !hex) return ENTITIES[name.toLowerCase()] ?? m;
      const cp = dec ? Number(dec) : parseInt(hex, 16);
      // Past Unicode's last code point: left as written rather than refusing the whole page.
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/\s+/g, " ")
    .trim();

// RBN writes most bands in metres ("40m", "2m", "70cm") and the 630 m band as "472kHz".
const BAND = /^(?:\d+c?m|\d+kHz)$/;

/** A grid as RBN gives it (operators type their own), upper-cased (8 characters kept to 6), or null when it isn't a Maidenhead locator. */
export function maidenhead(raw: string): string | null {
  const grid = raw.trim().toUpperCase();
  return LOCATOR.test(grid) ? grid.slice(0, 6) : null;
}

/**
 * The skimmers in RBN's list page, fetched at `fetchedAt` (ms): each row's
 * callsign, bands, grid and last-seen time (the page gives it as seconds
 * before the fetch). Throws if a row isn't the 9 cells RBN's table has, or
 * its column links don't match, or fewer than RBN_MIN_SKIMMERS skimmers
 * have a usable grid, so a changed or broken page is never saved as a day.
 */
export function parseSkimmerList(html: string, fetchedAt: number): Skimmer[] {
  const byCall = new Map<string, Skimmer>();
  for (const [, row] of html.matchAll(ROW)) {
    const cells = [...row!.matchAll(CELL)].map((m) => m[1]!);
    if (cells.length !== 9 || CELL_MARKS.some(([i, mark]) => !cells[i]!.includes(mark)))
      throw new Error("Not RBN's skimmer list: a row doesn't have the expected columns.");
    const firstSeen = HIDDEN_SECONDS.exec(cells[7]!);
    const seconds = HIDDEN_SECONDS.exec(cells[8]!);
    const call = text(cells[0]!).toUpperCase();
    if (!firstSeen || !seconds || !/^[A-Z0-9/-]+$/.test(call))
      throw new Error("Not RBN's skimmer list: a row's callsign or last-seen time can't be read.");
    // First seen can't be more recent than last seen: catches the two time columns swapped.
    if (Number(seconds[1]) > Number(firstSeen[1]))
      throw new Error("Not RBN's skimmer list: a row's last-seen time is older than its first-seen time.");
    const skimmer: Skimmer = {
      call,
      grid: maidenhead(text(cells[2]!)),
      bands: text(cells[1]!)
        .split(",")
        .map((b) => b.trim())
        .filter((b) => BAND.test(b)),
      lastSeen: fetchedAt - Number(seconds[1]) * 1000,
    };
    // A callsign listed twice keeps its most recent row.
    const seen = byCall.get(call);
    if (!seen || skimmer.lastSeen > seen.lastSeen) byCall.set(call, skimmer);
  }
  // A page cut off partway leaves its last row unclosed: refuse it rather than
  // save the rows before the cut as the whole list.
  const opened = html.match(/<tr[\s>]/g)?.length ?? 0;
  if (opened !== (html.match(/<\/tr>/g)?.length ?? 0))
    throw new Error("Not RBN's whole skimmer list: the page ends partway through a row.");
  // RBN's page ends right after its last row. Anything else there (a PHP error
  // or timeout message, say) means the list stopped early at a row boundary.
  const end = html.lastIndexOf("</tr>");
  if (end >= 0 && html.slice(end + "</tr>".length).trim() !== "")
    throw new Error("Not RBN's whole skimmer list: something follows the last row.");
  const skimmers = [...byCall.values()];
  const placed = skimmers.filter((s) => s.grid !== null).length;
  if (placed < RBN_MIN_SKIMMERS)
    throw new Error(`RBN skimmer list refused: ${placed} skimmers with a usable grid, under ${RBN_MIN_SKIMMERS}.`);
  return skimmers;
}
