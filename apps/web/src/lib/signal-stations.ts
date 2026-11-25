/**
 * Signal stations (issue #98, part of #104): the HF oddities people go looking
 * for (time signals, markers like UVB-76, numbers stations), as a hand-curated
 * catalog plus what's on the air at a given moment. Pure: every function takes
 * the time it's asked about, which the page reads from the server-corrected
 * clock (server-clock.ts), as ibp.ts and ghostnet.ts do.
 *
 * Sources: operator pages (NIST) and Wikipedia, checked 2026-11-24, and
 * Priyom (priyom.org, CC BY-NC-SA 4.0) for the numbers stations, read
 * 2026-11-25; each entry links its own, and the panel must credit Priyom.
 * Facts only: blurbs and notes are our own words. Nothing is fetched.
 *
 * Not yet checked against Priyom (do before #100 shows the panel):
 * - The Pip's and Squeaky Wheel's modes (USB, as UVB-76's; their pages don't say).
 * - Their day/night switch times: unpublished, so `dayNight` follows the sun at
 *   the transmitter (owner's choice) and can be wrong for a while around dawn and dusk.
 * - Squeaky Wheel's channels (Wikipedia's 5367/3363.5; VE3SUN's list has 3829.18/3830.45).
 *
 * Left out of #98's seed list for now, each waiting on a source:
 * - CHU is listed as defunct: Wikipedia says its last broadcast was 2023-10-09
 *   (NRC's own page refused automated fetches). The issue listed it as live.
 * - UVB-76's night channel, Swedish Rhapsody (no end date found), and
 *   VE3SUN-only entries such as HD2IOA (waiting on his OK).
 * - Priyom's other active stations (M01, M14, M23, V13, V28, V32...): their pages aren't read yet.
 */

import { onDay } from "./eibi";
import type { Mode } from "./radio-types";
import { isNight, sunPosition } from "./solar";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** How far ahead nextStartAfter looks. */
const LOOKAHEAD_DAYS = 7;

export type SignalCategory = "numbers" | "time" | "marker" | "military" | "other";

export type SignalChannel = { khz: number; mode: Mode };

/**
 * A daily slot in UTC minutes since midnight, half-open [start, end). An end
 * at or before the start runs past midnight. `days` is EiBi's days field
 * ("Mo-Fr", "SaSu", "1245"; blank or missing for daily) and, as in EiBi, it
 * names the UTC day the window starts on. `khz` must be one of the station's channels.
 */
export type SignalWindow = { days?: string; startUtc: number; endUtc: number; khz: number };

export type Schedule =
  | { kind: "always" }
  /**
   * On all the time, on one channel by day and another by night, switching at
   * unpublished times: the sun at the transmitter decides which (`tx` required).
   */
  | { kind: "dayNight"; dayKhz: number; nightKhz: number }
  | { kind: "windows"; windows: readonly SignalWindow[] }
  /** Listed, never shown as on now: no schedule we can trust. May have no channels (nothing fixed to tune). */
  | { kind: "irregular"; note: string }
  /** History only, no Listen. `ended` is "YYYY-MM" when a source gives it. */
  | { kind: "defunct"; ended?: string };

export type Transmitter = {
  lat: number;
  lon: number;
  label: string;
  /** "known": a published site; "approx": a reported area; "country": the country only. */
  confidence: "known" | "approx" | "country";
};

export type SignalStation = {
  slug: string;
  name: string;
  aka: readonly string[];
  category: SignalCategory;
  /** The first is the main one (what activeChannelAt returns for an always-on station). Empty when nothing is fixed to tune. */
  channels: readonly SignalChannel[];
  schedule: Schedule;
  /** Required for every station that isn't defunct (receiver ranking, #99). */
  tx?: Transmitter;
  /** Priyom's designator, when the station's transmissions come from Priyom's schedule (priyom-schedule.ts). */
  priyom?: string;
  blurb: string;
  sources: readonly string[];
};

const am = (khz: number): SignalChannel => ({ khz, mode: "am" });
const usb = (khz: number): SignalChannel => ({ khz, mode: "usb" });
const cw = (khz: number): SignalChannel => ({ khz, mode: "cw" });

// Numbers stations (Priyom, read 2026-11-25): no fixed frequencies (they change
// monthly or by season), so these list no channels here. Their times and
// frequencies come from Priyom's live schedule (priyom-schedule.ts, served by
// signals.priyom); without it they're listed with no Listen. Sites are as Priyom gives them.
const MOSCOW: Transmitter = { lat: 55.75, lon: 37.62, label: "Moscow, Russia", confidence: "approx" };
const WARSAW: Transmitter = { lat: 52.4294, lon: 20.8814, label: "near Warsaw, Poland", confidence: "known" };
const RUSSIAN_7_NOTE =
  "Usually twice a week, three transmissions 20 minutes apart on different frequencies, which change monthly.";
const POLISH_11_NOTE =
  "Twice a week on year-round UTC times, on a frequency that changes with the season.";

export const SIGNAL_STATIONS: readonly SignalStation[] = [
  {
    slug: "wwv",
    name: "WWV",
    aka: [],
    category: "time",
    // 25 MHz is "experimental" (Wikipedia), so it's left out.
    channels: [am(10_000), am(5_000), am(15_000), am(2_500), am(20_000)],
    schedule: { kind: "always" },
    tx: { lat: 40.6797, lon: -105.0425, label: "Fort Collins, Colorado", confidence: "known" },
    blurb:
      "The US time standard on shortwave: a tick every second and a voice announcing the time each minute, around the clock.",
    sources: [
      "https://www.nist.gov/pml/time-and-frequency-division/time-distribution/radio-station-wwv",
      "https://en.wikipedia.org/wiki/WWV_(radio_station)",
    ],
  },
  {
    slug: "wwvh",
    name: "WWVH",
    aka: [],
    category: "time",
    channels: [am(10_000), am(5_000), am(15_000), am(2_500)],
    schedule: { kind: "always" },
    tx: { lat: 21.9878, lon: -159.7631, label: "Kekaha, Kauai, Hawaii", confidence: "known" },
    blurb:
      "WWV's sister station in Hawaii, on the same frequencies with a woman's voice, so where both are heard you can tell them apart.",
    sources: [
      "https://www.nist.gov/pml/time-and-frequency-division/time-distribution/radio-station-wwvh",
      "https://en.wikipedia.org/wiki/WWVH",
    ],
  },
  {
    slug: "rwm",
    name: "RWM",
    aka: [],
    category: "time",
    channels: [cw(9_996), cw(4_996), cw(14_996)],
    schedule: { kind: "always" },
    tx: { lat: 55.7269, lon: 38.2082, label: "near Moscow, Russia", confidence: "known" },
    blurb: "Russia's shortwave time and frequency standard: keyed carrier pulses, no voice.",
    sources: ["https://en.wikipedia.org/wiki/RWM"],
  },
  {
    slug: "uvb-76",
    name: "UVB-76",
    aka: ["The Buzzer", "ZhUOZ"],
    category: "marker",
    channels: [usb(4_625)],
    schedule: { kind: "always" },
    tx: { lat: 55.38, lon: 36.73, label: "Naro-Fominsk, Russia", confidence: "approx" },
    blurb:
      "A short buzz repeated around the clock since at least 1982, broken now and then by a voice reading Russian code words.",
    sources: ["https://en.wikipedia.org/wiki/UVB-76"],
  },
  {
    slug: "the-pip",
    name: "The Pip",
    aka: [],
    category: "marker",
    channels: [usb(5_448), usb(3_756)],
    schedule: { kind: "dayNight", dayKhz: 5_448, nightKhz: 3_756 },
    tx: { lat: 47.24, lon: 39.71, label: "near Rostov-on-Don, Russia", confidence: "approx" },
    blurb: "A fast, steady pip from a Russian military network, with the odd voice message between the pips.",
    sources: ["https://en.wikipedia.org/wiki/The_Pip"],
  },
  {
    slug: "squeaky-wheel",
    name: "The Squeaky Wheel",
    aka: [],
    category: "marker",
    channels: [usb(5_367), usb(3_363.5)],
    schedule: { kind: "dayNight", dayKhz: 5_367, nightKhz: 3_363.5 },
    tx: { lat: 47.24, lon: 39.71, label: "thought to be near Rostov-on-Don, Russia", confidence: "approx" },
    blurb: "The Pip's partner in the same network. Its squeak gave it the name; since 2023 it sends a low-tone pip instead.",
    sources: ["https://en.wikipedia.org/wiki/The_Squeaky_Wheel"],
  },
  {
    slug: "e07",
    name: "E07",
    priyom: "E07",
    aka: ["English Man"],
    category: "numbers",
    channels: [],
    schedule: { kind: "irregular", note: RUSSIAN_7_NOTE },
    tx: MOSCOW,
    blurb: "A man's voice reading groups of numbers in English, from the Russian operator Priyom calls \"7\".",
    sources: ["https://priyom.org/number-stations/english/e07"],
  },
  {
    slug: "e11",
    name: "E11",
    priyom: "E11",
    aka: ["Oblique"],
    category: "numbers",
    channels: [],
    schedule: { kind: "irregular", note: POLISH_11_NOTE },
    tx: WARSAW,
    blurb: "A woman's voice reading numbers in English, from the Polish operator Priyom calls \"11\".",
    sources: ["https://priyom.org/number-stations/english/e11"],
  },
  {
    slug: "s06",
    name: "S06",
    priyom: "S06",
    aka: ["Russian Man"],
    category: "numbers",
    channels: [],
    schedule: {
      kind: "irregular",
      note: "Two transmissions 30 or 60 minutes apart on different frequencies, often repeated the next day.",
    },
    tx: MOSCOW,
    blurb: "A man's voice reading groups of numbers in Russian, sent from several sites across Russia.",
    sources: ["https://priyom.org/number-stations/slavic/s06"],
  },
  {
    slug: "s11a",
    name: "S11a",
    priyom: "S11a",
    aka: ["Cherta"],
    category: "numbers",
    channels: [],
    schedule: { kind: "irregular", note: POLISH_11_NOTE },
    tx: WARSAW,
    blurb: "E11's Russian-language counterpart: a woman's voice reading numbers in Russian, from Poland.",
    sources: ["https://priyom.org/number-stations/slavic/s11a"],
  },
  {
    slug: "v07",
    name: "V07",
    priyom: "V07",
    aka: ["Spanish Lady"],
    category: "numbers",
    channels: [],
    schedule: { kind: "irregular", note: RUSSIAN_7_NOTE },
    tx: { lat: 48.48, lon: 135.07, label: "Khabarovsk, Russia", confidence: "approx" },
    blurb: "E07's Spanish-language counterpart: a woman's voice reading numbers in Spanish, sent from Russia's Far East.",
    sources: ["https://priyom.org/number-stations/other/v07"],
  },
  {
    slug: "m12",
    name: "M12",
    priyom: "M12",
    aka: [],
    category: "numbers",
    channels: [],
    schedule: { kind: "irregular", note: RUSSIAN_7_NOTE },
    tx: MOSCOW,
    blurb: "The Morse code station of the Russian operator Priyom calls \"7\" (E07's operator).",
    sources: ["https://priyom.org/number-stations/morse/m12"],
  },
  {
    slug: "chu",
    name: "CHU",
    aka: [],
    category: "time",
    channels: [usb(3_330), usb(7_850), usb(14_670)],
    schedule: { kind: "defunct", ended: "2023-10" },
    blurb: "Canada's time signal from near Ottawa, with announcements in English and French. Its last broadcast was 9 October 2023.",
    sources: ["https://en.wikipedia.org/wiki/CHU_(radio_station)"],
  },
  {
    slug: "lincolnshire-poacher",
    name: "Lincolnshire Poacher",
    aka: [],
    category: "numbers",
    channels: [],
    schedule: { kind: "defunct", ended: "2008-07" },
    blurb:
      "Played bars of the English folk song between groups of numbers read by a woman's voice. Traced by listeners to Cyprus; last heard in July 2008.",
    sources: ["https://en.wikipedia.org/wiki/Lincolnshire_Poacher_(numbers_station)"],
  },
  {
    slug: "cherry-ripe",
    name: "Cherry Ripe",
    aka: [],
    category: "numbers",
    channels: [],
    schedule: { kind: "defunct", ended: "2009-12" },
    blurb: "Took over part of the Lincolnshire Poacher's role, with another folk song as its signal, until December 2009.",
    sources: ["https://en.wikipedia.org/wiki/Cherry_Ripe_(numbers_station)"],
  },
];

export function findStation(slug: string): SignalStation | undefined {
  return SIGNAL_STATIONS.find((s) => s.slug === slug);
}

/** 00:00 UTC of the day `ms` falls in. */
const dayStartOf = (ms: number) => ms - (((ms % DAY) + DAY) % DAY);

/** A window's span when it starts on the UTC day beginning `dayStart`, or null if `days` rules that day out. */
function spanOn(w: SignalWindow, dayStart: number): { startMs: number; endMs: number } | null {
  if (!onDay(w.days ?? "", new Date(dayStart))) return null;
  const startMs = dayStart + w.startUtc * MINUTE;
  const endMs = dayStart + w.endUtc * MINUTE + (w.endUtc <= w.startUtc ? DAY : 0);
  return { startMs, endMs };
}

/** The window open at `ms`, with its span: one that started today, or yesterday and runs past midnight. */
function openWindow(station: SignalStation, ms: number): { w: SignalWindow; startMs: number; endMs: number } | null {
  if (station.schedule.kind !== "windows") return null;
  const today = dayStartOf(ms);
  for (const w of station.schedule.windows)
    for (const dayStart of [today, today - DAY]) {
      const span = spanOn(w, dayStart);
      if (span && span.startMs <= ms && ms < span.endMs) return { w, ...span };
    }
  return null;
}

const windowAt = (station: SignalStation, ms: number) => openWindow(station, ms)?.w ?? null;

/** When the window open at `ms` started and ends (Unix ms), or null when none is open (always-on stations included). */
export function windowSpanAt(station: SignalStation, ms: number): { startMs: number; endMs: number } | null {
  const o = openWindow(station, ms);
  return o && { startMs: o.startMs, endMs: o.endMs };
}

/** Whether `station` is scheduled on the air at `ms`. Irregular and defunct stations never are. */
export function onAirAt(station: SignalStation, ms: number): boolean {
  if (station.schedule.kind === "always" || station.schedule.kind === "dayNight") return true;
  return windowAt(station, ms) !== null;
}

/**
 * The channel to tune at `ms`: the open window's, the main one for an always-on
 * station, the day or night one by the sun at the transmitter, else null.
 */
export function activeChannelAt(station: SignalStation, ms: number): SignalChannel | null {
  const { schedule, tx } = station;
  if (schedule.kind === "always") return station.channels[0] ?? null;
  if (schedule.kind === "dayNight") {
    if (!tx) return null;
    const khz = isNight(tx.lat, tx.lon, sunPosition(ms)) ? schedule.nightKhz : schedule.dayKhz;
    return station.channels.find((c) => c.khz === khz) ?? null;
  }
  const w = windowAt(station, ms);
  return w ? (station.channels.find((c) => c.khz === w.khz) ?? null) : null;
}

/**
 * When `station`'s next window opens after `ms` (Unix ms), up to 7 days ahead;
 * null for always-on (including day/night), irregular and defunct stations, or nothing that soon.
 */
export function nextStartAfter(station: SignalStation, ms: number): number | null {
  if (station.schedule.kind !== "windows") return null;
  const today = dayStartOf(ms);
  let best: number | null = null;
  for (const w of station.schedule.windows)
    for (let d = 0; d <= LOOKAHEAD_DAYS; d++) {
      const span = spanOn(w, today + d * DAY);
      if (!span || span.startMs <= ms || span.startMs > ms + LOOKAHEAD_DAYS * DAY) continue;
      if (best === null || span.startMs < best) best = span.startMs;
      break;
    }
  return best;
}
