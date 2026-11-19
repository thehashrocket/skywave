/**
 * NCDXF's official IBP beacon status (issue #69): which beacons are off the
 * air, and why. Two small files the IBP coordinator keeps, checked daily but
 * updated from the operators' reports, which can take days; a beacon off for
 * a contest never shows. Pure: the server fetches and caches them
 * (server/routers/beacons.ts).
 *
 * IBPStatus.csv: a timestamp line, then `CALL,STATUS,footnote` per beacon,
 * STATUS `OK` or `OFF`. IBPStatusFootnotes.csv: a timestamp line, then
 * `number,"text"`. Parsing is forgiving: an unknown status counts as OK, a
 * missing or unknown footnote gives no text, and lines it can't read are
 * skipped. A file with no beacon line at all isn't the status file (an error
 * page, a moved URL) and is refused, so the last good copy stays.
 */

import { BEACONS } from "./ibp";

export const IBP_STATUS_URL = "https://www.ncdxf.org/beacon/IBPStatus.csv";
export const IBP_FOOTNOTES_URL = "https://www.ncdxf.org/beacon/IBPStatusFootnotes.csv";

/** One beacon's official status: off the air or not, and NCDXF's note about it. */
export type BeaconStatus = { call: string; off: boolean; note: string | null };

/** The status of each beacon NCDXF lists, in transmission order, and when NCDXF last changed the file. */
export type IbpStatus = { stampedAt: string | null; beacons: BeaconStatus[] };

const KNOWN = new Set(BEACONS.map((b) => b.call));

/** The lines of a file, without a byte-order mark, line endings or blank lines. */
function lines(text: string): string[] {
  return text
    .replace(/^﻿/, "")
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** The first line when it's a timestamp, as an ISO string; null otherwise. */
function stamp(first: string | undefined): string | null {
  if (!first || first.includes(",")) return null;
  const ms = Date.parse(first);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * One CSV line's fields: commas split them, and a field in double quotes may
 * hold commas and doubled quotes. An unclosed quote runs to the end of the line.
 */
export function csvFields(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  for (;;) {
    let field = "";
    while (line[i] === " ") i++;
    if (line[i] === '"') {
      i++;
      for (;;) {
        const q = line.indexOf('"', i);
        if (q < 0) {
          field += line.slice(i);
          i = line.length;
          break;
        }
        field += line.slice(i, q);
        if (line[q + 1] === '"') {
          field += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      const comma = line.indexOf(",", i);
      i = comma < 0 ? line.length : comma;
    } else {
      const comma = line.indexOf(",", i);
      const end = comma < 0 ? line.length : comma;
      field = line.slice(i, end).trim();
      i = end;
    }
    fields.push(field);
    if (i >= line.length) return fields;
    i++; // past the comma
  }
}

/** Footnote number to text, from IBPStatusFootnotes.csv. Empty texts and unreadable lines are left out. */
export function parseFootnotes(text: string): Map<string, string> {
  const notes = new Map<string, string>();
  for (const line of lines(text)) {
    const [n, note] = csvFields(line);
    if (!n || !/^\d+$/.test(n) || !note?.trim()) continue;
    notes.set(String(Number(n)), note.trim());
  }
  return notes;
}

/**
 * The beacons' status from IBPStatus.csv, with each footnote's text from
 * `footnotes`. Only the 18 beacons skywave knows count; a callsign listed
 * twice takes its last line. Throws when no line names a known beacon.
 */
export function parseIbpStatus(text: string, footnotes: ReadonlyMap<string, string> = new Map()): IbpStatus {
  const all = lines(text);
  const stampedAt = stamp(all[0]);
  const found = new Map<string, BeaconStatus>();
  for (const line of stampedAt === null ? all : all.slice(1)) {
    const [rawCall, rawStatus, rawNote] = csvFields(line);
    const call = rawCall?.toUpperCase();
    if (!call || !KNOWN.has(call)) continue;
    const n = rawNote && /^\d+$/.test(rawNote) ? String(Number(rawNote)) : null;
    found.set(call, {
      call,
      // Only an explicit OFF is off: anything else NCDXF might write counts as on the air.
      off: rawStatus?.toUpperCase() === "OFF",
      note: (n !== null && footnotes.get(n)) || null,
    });
  }
  if (found.size === 0) throw new Error("Not the IBP status file: no beacon lines.");
  return { stampedAt, beacons: BEACONS.flatMap((b) => found.get(b.call) ?? []) };
}

/** The beacons off the air, callsign to NCDXF's note (null for none). */
export function offBeacons(status: IbpStatus | null | undefined): ReadonlyMap<string, string | null> {
  return new Map((status?.beacons ?? []).filter((b) => b.off).map((b) => [b.call, b.note]));
}
