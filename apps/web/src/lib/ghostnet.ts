/**
 * GhostNet (issue #91): S2 Underground's weekly HF nets and data bridges, on a
 * fixed UTC schedule, and which receivers are placed to hear each one. Pure:
 * every function takes the time it's asked about, which the page reads from
 * the server-corrected clock (server-clock.ts), as ibp.ts does.
 *
 * Source: the GhostNet Version 1.5 field guide (github.com/s2underground/GhostNet,
 * CC BY-NC-SA 4.0; times, frequencies and modes are facts, the guide's prose is
 * not copied). All times are UTC and don't move with daylight saving. The North
 * America net starts 0100 UTC Friday ("technically the next day", the guide
 * says); the Europe (1800) and Australia (0700) nets are on Thursday UTC.
 */

import { byRank, covers, isFull, type Receiver } from "./kiwi-list";
import { formatCountdown } from "./reception";
import type { Mode } from "./radio-types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The Unix epoch fell on a Thursday, so week offsets count from Thursday 00:00 UTC. */
export const WEEK_MS = 7 * DAY;
const THU = 0;
const FRI = DAY;
const SAT = 2 * DAY;

export type RegionId = "na" | "eu" | "au" | "sp";

/**
 * A lat/lon box (owner D2, D16). `lonMin` greater than `lonMax` means the box
 * crosses the 180° line (the South Pacific). Coarse on purpose: the test is
 * "inside the net's region", not reception.
 */
export type Region = { name: string; latMin: number; latMax: number; lonMin: number; lonMax: number };

export const REGIONS: Record<RegionId, Region> = {
  na: { name: "North America", latMin: 24, latMax: 72, lonMin: -170, lonMax: -52 },
  eu: { name: "Europe", latMin: 35, latMax: 72, lonMin: -11, lonMax: 40 },
  au: { name: "Australia", latMin: -44, latMax: -10, lonMin: 112, lonMax: 154 },
  sp: { name: "South Pacific", latMin: -48, latMax: -5, lonMin: 160, lonMax: -140 },
};

export function inRegion(region: Region, lat: number, lon: number): boolean {
  if (lat < region.latMin || lat > region.latMax) return false;
  return region.lonMin <= region.lonMax
    ? lon >= region.lonMin && lon <= region.lonMax
    : lon >= region.lonMin || lon <= region.lonMax;
}

export type SlotKind = "js8" | "vara" | "rtty" | "voice" | "ale";

export const KIND_LABELS: Record<SlotKind, string> = {
  js8: "JS8Call",
  vara: "Winlink VARA",
  rtty: "RTTY",
  voice: "Emergency voice",
  ale: "Ion2G ALE",
};

/** The ten USB channels an Ion2G ALE window hops across, kHz: no single Listen frequency. */
export const ALE_CHANNELS_KHZ = [3598.5, 7104.5, 7106.5, 7108.5, 10128.5, 14111.5, 14113.5, 14115.5, 18108.5, 28108.5];

/**
 * RTTY's 7.077 MHz is read as the mark tone, as a radio's RTTY preset shows it
 * (owner D8): the USB dial sits 2.125 kHz below, so the mark lands at 2125 Hz
 * and the space, 170 Hz lower, at 1955 Hz, inside the 300-2700 Hz passband
 * (dsp.py PASSBANDS) and where #92's decoder looks. Unconfirmed on the air;
 * see TODOS.md "GhostNet: confirm the RTTY dial on a live slot".
 */
export const RTTY_MARK_OFFSET_KHZ = 2.125;

export type Slot = {
  kind: SlotKind;
  /** The frequency the guide lists, kHz; null for ALE, which hops. */
  guideKhz: number | null;
  /** Where the dial goes, kHz; null for ALE. */
  dialKhz: number | null;
  mode: Mode | null;
  /** From the start of the week (Thursday 00:00 UTC), ms. */
  startMs: number;
  endMs: number;
};

export type GhostEvent = {
  id: string;
  name: string;
  /** Receivers inside any of these count as in region; a bridge has both ends. */
  regions: readonly RegionId[];
  /** In time order. */
  slots: readonly Slot[];
};

function slot(kind: SlotKind, guideKhz: number | null, start: number, minutes: number): Slot {
  const dialKhz = guideKhz === null ? null : kind === "rtty" ? guideKhz - RTTY_MARK_OFFSET_KHZ : guideKhz;
  const mode: Mode | null = guideKhz === null ? null : kind === "voice" ? "lsb" : "usb";
  return { kind, guideKhz, dialKhz, mode, startMs: start, endMs: start + minutes * MINUTE };
}

/** A regional 40m net: four 30-minute slots from `start` (NVIS, guide's net pages). */
function net(id: string, name: string, region: RegionId, start: number): GhostEvent {
  return {
    id,
    name,
    regions: [region],
    slots: [
      slot("js8", 7107, start, 30),
      slot("vara", 7107, start + 30 * MINUTE, 30),
      slot("rtty", 7077, start + 60 * MINUTE, 30),
      slot("voice", 7190, start + 90 * MINUTE, 30),
    ],
  };
}

const sat = (h: number, m = 0) => SAT + h * HOUR + m * MINUTE;

export const EVENTS: readonly GhostEvent[] = [
  net("na", "North America net", "na", FRI + 1 * HOUR),
  net("eu", "Europe net", "eu", THU + 18 * HOUR),
  net("au", "Australia net", "au", THU + 7 * HOUR),
  {
    id: "na-eu",
    name: "NA–Europe bridge",
    regions: ["na", "eu"],
    slots: [slot("js8", 14107, sat(18), 60), slot("ale", null, sat(19), 60)],
  },
  {
    id: "na-au",
    name: "NA–Australia bridge",
    regions: ["na", "au"],
    slots: [slot("js8", 14107, sat(12), 60), slot("ale", null, sat(13), 30), slot("js8", 3575, sat(13, 30), 30)],
  },
  {
    id: "eu-au",
    name: "Europe–Australia bridge",
    regions: ["eu", "au"],
    slots: [slot("js8", 14107, sat(20), 60), slot("ale", null, sat(21), 30), slot("js8", 3575, sat(21, 30), 30)],
  },
  {
    id: "au-sp",
    name: "Australia–South Pacific bridge",
    regions: ["au", "sp"],
    slots: [slot("js8", 14107, sat(8), 60), slot("js8", 7107, sat(9), 30), slot("ale", null, sat(9, 30), 30)],
  },
];

/** One slot on a real date: start and end are Unix ms. */
export type Occurrence = { event: GhostEvent; slot: Slot; index: number; startMs: number; endMs: number };

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Thursday 00:00 UTC of the week that contains `ms`. */
const weekStartOf = (ms: number) => ms - mod(ms, WEEK_MS);

/** `event`'s slot `index` in the week starting at `weekStart`. */
function occurrenceIn(event: GhostEvent, index: number, weekStart: number): Occurrence {
  const slot = event.slots[index]!;
  return { event, slot, index, startMs: weekStart + slot.startMs, endMs: weekStart + slot.endMs };
}

/** The slots on the air at `ms`: at most one per event, half-open [start, end). */
export function windowsAt(ms: number): Occurrence[] {
  const out: Occurrence[] = [];
  for (const event of EVENTS)
    event.slots.forEach((_, i) => {
      const o = occurrenceIn(event, i, weekStartOf(ms));
      if (o.startMs <= ms && ms < o.endMs) out.push(o);
    });
  return out;
}

/** The slot after `o` in its event, or null for the last. */
export function followingSlot(o: Occurrence): Occurrence | null {
  const i = o.index + 1;
  return i < o.event.slots.length ? occurrenceIn(o.event, i, o.startMs - o.slot.startMs) : null;
}

/** `event`'s next opening (its first slot) that starts after `ms`. */
export function nextStart(event: GhostEvent, ms: number): Occurrence {
  const o = occurrenceIn(event, 0, weekStartOf(ms));
  return o.startMs > ms ? o : occurrenceIn(event, 0, weekStartOf(ms) + WEEK_MS);
}

/** The soonest event opening after `ms`. */
export function nextWindow(ms: number): Occurrence {
  return EVENTS.map((e) => nextStart(e, ms)).reduce((a, b) => (b.startMs < a.startMs ? b : a));
}

/** When `o`'s net or bridge window ends: the end of its last slot that week (Unix ms). */
export function eventEnd(o: Occurrence): number {
  const last = o.event.slots[o.event.slots.length - 1]!;
  return o.startMs - o.slot.startMs + last.endMs;
}

export function msUntil(o: Occurrence, ms: number): number {
  return o.startMs - ms;
}

/**
 * The strip's rows at `ms` (owner D13): the slot on the air for each running
 * event, then one row per event not running, at its next opening, soonest first.
 */
export function stripRows(ms: number): { onNow: Occurrence[]; next: Occurrence[] } {
  const onNow = windowsAt(ms);
  const running = new Set(onNow.map((o) => o.event.id));
  const next = EVENTS.filter((e) => !running.has(e.id))
    .map((e) => nextStart(e, ms))
    .sort((a, b) => a.startMs - b.startMs);
  return { onNow, next };
}

/** Listen shows this long before a window opens, and while it's on (owner D9): no slot held for days of silence. */
export const GHOSTNET_LISTEN_LEAD_MS = 15 * MINUTE;

/** Whether `o` offers Listen at `ms`: a single frequency, on now or opening within the lead. */
export function listenOffered(o: Occurrence, ms: number): boolean {
  return o.slot.dialKhz !== null && ms >= o.startMs - GHOSTNET_LISTEN_LEAD_MS && ms < o.endMs;
}

/**
 * How far the dial can sit from a row's dial and still count as tuned to it
 * (owner D12): USB passes 300-2700 Hz above the dial and JS8 heartbeats sit
 * under 1000 Hz, so past 0.1 kHz part of the net falls out of the filter.
 */
export const GHOSTNET_TOLERANCE_KHZ = 0.1;

/** Whether the dial is on `slot`'s frequency in any mode (a GhostNet pick follows its net this way, owner D11). */
export function onSlotFrequency(slot: Slot, freqKhz: number): boolean {
  // A hair over the tolerance for floating point (7107.1 - 7107 is 0.1000000000004).
  return slot.dialKhz !== null && Math.abs(freqKhz - slot.dialKhz) <= GHOSTNET_TOLERANCE_KHZ + 1e-6;
}

/** Whether the dial is on `s`'s frequency and in its mode (owner D12). */
export function isTuned(s: Slot, dialKhz: number, mode: Mode): boolean {
  return s.mode === mode && onSlotFrequency(s, dialKhz);
}

/**
 * The receivers that can tune `khz`, ordered by, in turn: not full (full ones
 * go last, D18), placed (no position after), inside one of `regions` (owner
 * D2, D16), then the usual order (byRank), as rankForBeacon does. No noise
 * ordering (D17).
 */
export function rankForRegion(receivers: readonly Receiver[], regions: readonly RegionId[], khz: number): Receiver[] {
  const placed = (r: Receiver) => r.lat !== undefined && r.lon !== undefined;
  const inside = (r: Receiver) => placed(r) && regions.some((id) => inRegion(REGIONS[id], r.lat!, r.lon!));
  return receivers
    .filter((r) => covers(r, khz))
    .sort(
      (a, b) =>
        Number(isFull(a)) - Number(isFull(b)) ||
        Number(!placed(a)) - Number(!placed(b)) ||
        Number(!inside(a)) - Number(!inside(b)) ||
        byRank(a, b),
    );
}

/** A wait as "3d 4h", "2h 5m", or m:ss under an hour; with `seconds` false, "12 min" under an hour. */
export function formatWait(ms: number, seconds = true): string {
  const t = Math.max(0, ms);
  if (t >= DAY) return `${Math.floor(t / DAY)}d ${Math.floor((t % DAY) / HOUR)}h`;
  if (t >= HOUR) return `${Math.floor(t / HOUR)}h ${Math.floor((t % HOUR) / MINUTE)}m`;
  return seconds ? formatCountdown(t) : `${Math.max(1, Math.ceil(t / MINUTE))} min`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Fri": the UTC weekday. */
export const utcDay = (ms: number) => WEEKDAYS[new Date(ms).getUTCDay()]!;

/** "Fri 0100 UTC". */
export function utcLabel(ms: number): string {
  const d = new Date(ms);
  return `${utcDay(ms)} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())} UTC`;
}

/** "0100–0130 UTC" for a slot's span (same UTC day for every GhostNet slot). */
export function utcSpan(o: Occurrence): string {
  const a = new Date(o.startMs);
  const b = new Date(o.endMs);
  return `${pad(a.getUTCHours())}${pad(a.getUTCMinutes())}–${pad(b.getUTCHours())}${pad(b.getUTCMinutes())} UTC`;
}

/**
 * "Thu 5:00 pm PST": the weekday always (owner D16, the NA net's Friday UTC is
 * Thursday in the Americas) and the device's short zone name (D17). `timeZone`
 * is for tests; the page passes none, so it's the device's zone.
 */
export function localLabel(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
    timeZone,
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()} ${get("timeZoneName")}`;
}

/** "7.107" from kHz, as the guide writes it; more digits for a dial like 7.0749. */
export const mhz = (khz: number, digits = 3) => (khz / 1000).toFixed(digits);
