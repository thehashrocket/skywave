import { type Broadcast, onAirAt, seasonFor } from "./eibi";
import { BROADCAST_BANDS, guessMode, HAM_BANDS, type Mode } from "./radio-types";

/**
 * Find a station by name in the EiBi schedule (a listener's request; station
 * search eng review D1-D11, design review, re-check). Pure: the page passes
 * the schedule and its own clock, the same one the station names use (D6).
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** One broadcast found: one per frequency, time, station and language (EiBi lists each transmitter). */
export type FoundBroadcast = {
  khz: number;
  station: string;
  lang: string;
  /** Target codes of every listing merged into this one, in schedule order, blanks left out (re-check D4). */
  targets: string[];
  /** On the air at the time searched. */
  onNow: boolean;
  /** When it next starts, ms, within the coming 24 h and this season (D1, D7); absent when on now. */
  startsAt?: number;
};

export type SearchResult = {
  /** On now first, lowest frequency first; then the rest by start time. */
  found: FoundBroadcast[];
  /** Every station whose name matches, found or not, so an empty list can say why (design 4A). */
  names: string[];
};

/**
 * EiBi's short forms and what they stand for, so "radio triunfal" finds
 * "R.Triunfal Evangélica" (D8). Applied to the station's name only; the
 * original stays searchable too.
 */
const SHORT_FORMS: [RegExp, string][] = [
  [/(^|[\s.,(/-])R\.\s?/g, "$1Radio "],
  [/\bVoA\b/g, "Voice of America"],
  [/\bInt\./g, "International "],
  [/\bExt\./g, "External "],
  [/\bSce\b/g, "Service"],
  [/\bBC\b/g, "Broadcasting"],
  [/\bBc\./g, "Broadcasting "],
];

/** Letters NFD leaves alone ("Bjørnøya"), spelled as a listener would type them. */
const LETTERS: Record<string, string> = { ø: "o", æ: "ae", œ: "oe", ß: "ss", ł: "l", đ: "d", ð: "d", þ: "th" };

/** Lowercase, without accents or the letters above: "Rádio Bjørnøya" reads "radio bjornoya". */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[øæœßłđðþ]/g, (c) => LETTERS[c]!);
}

/** What a name is searched as: its own folded text, plus the short forms spelled out. */
function searchText(name: string): string {
  const long = SHORT_FORMS.reduce((text, [form, word]) => text.replace(form, word), name);
  return long === name ? fold(name) : `${fold(name)} ${fold(long)}`;
}

// One search text per station name, kept per schedule (8,973 rows, 548 names in b26).
const textsBySchedule = new WeakMap<readonly Broadcast[], Map<string, string>>();
function textFor(schedule: readonly Broadcast[], name: string): string {
  let texts = textsBySchedule.get(schedule);
  if (!texts) textsBySchedule.set(schedule, (texts = new Map()));
  let text = texts.get(name);
  if (text === undefined) texts.set(name, (text = searchText(name)));
  return text;
}

/** The query's words, folded: every one must appear somewhere in the name, in any order. */
export function queryWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/**
 * The next start of a broadcast after `ms`, within the coming day, on a day
 * its days and dates allow. With `season` set, a later row past the season
 * change is left out, since the next season lists other frequencies (D7).
 */
function nextStart(b: Broadcast, ms: number, season: string | null): number | undefined {
  const midnight = Math.floor(ms / DAY) * DAY;
  for (const day of [0, 1]) {
    const at = midnight + day * DAY + b.start * MINUTE;
    if (at > ms && at <= ms + DAY && onAirAt(b, at) && (season === null || seasonFor(at) === season)) return at;
  }
  return undefined;
}

/**
 * Broadcasts whose station name holds every word of the query: on the air at
 * `ms`, or starting in the next 24 h. Each listing is checked on its own
 * before merging, since two listings alike but for their days or dates can be
 * on at different times (eng re-check, dedupe after onAirAt); merged listings
 * keep every target.
 */
export function findBroadcasts(
  schedule: readonly Broadcast[],
  query: string,
  ms: number,
  season: string,
): SearchResult {
  const words = queryWords(query);
  if (!words.length) return { found: [], names: [] };
  // The season cut only applies to this season's schedule: a fallback copy from
  // the season before (eibispace.de down at a switch) would lose every later row.
  const cutAt = season === seasonFor(ms) ? season : null;
  const names = new Set<string>();
  const merged = new Map<string, FoundBroadcast>();
  for (const b of schedule) {
    const text = textFor(schedule, b.station);
    if (!words.every((w) => text.includes(w))) continue;
    names.add(b.station);
    const onNow = onAirAt(b, ms);
    const startsAt = onNow ? undefined : nextStart(b, ms, cutAt);
    if (!onNow && startsAt === undefined) continue;
    const key = `${b.khz}|${b.start}|${b.end}|${b.station}|${b.lang}`;
    let f = merged.get(key);
    if (!f) merged.set(key, (f = { khz: b.khz, station: b.station, lang: b.lang, targets: [], onNow: false }));
    f.onNow ||= onNow;
    if (startsAt !== undefined && (f.startsAt === undefined || startsAt < f.startsAt)) f.startsAt = startsAt;
    const target = b.target.trim();
    if (target && !f.targets.includes(target)) f.targets.push(target);
  }
  // Listings that overlap but differ in their times are one row too: one per
  // frequency, station, language and "on now" or start time, as the page keys them.
  const rows = new Map<string, FoundBroadcast>();
  for (const m of merged.values()) {
    const f = m.onNow ? { ...m, startsAt: undefined } : m;
    const key = `${f.khz}|${f.station}|${f.lang}|${f.startsAt ?? "now"}`;
    const row = rows.get(key);
    if (!row) rows.set(key, f);
    else for (const t of f.targets) if (!row.targets.includes(t)) row.targets.push(t);
  }
  const found = [...rows.values()];
  found.sort(
    (a, b) =>
      Number(b.onNow) - Number(a.onNow) ||
      (a.startsAt ?? 0) - (b.startsAt ?? 0) ||
      a.khz - b.khz ||
      a.station.localeCompare(b.station),
  );
  return { found, names: [...names] };
}

type Range = readonly { startKhz: number; endKhz: number }[];
const inBand = (khz: number, bands: Range) => bands.some((b) => khz >= b.startKhz && khz <= b.endKhz);

/**
 * The HF aeronautical (R and OR) and maritime mobile allocations of the ITU
 * Radio Regulations, Article 5, where Volmet, coast stations and their kin
 * talk in USB. Kept short of every broadcast band the dial knows.
 */
const MOBILE_BANDS: Range = [
  [2850, 3155],
  [3400, 3500],
  [4063, 4438],
  [4650, 4750],
  [5450, 5730],
  [6200, 6765],
  [8195, 9040],
  [10005, 10100],
  [11175, 11400],
  [12230, 13360],
  [15010, 15100],
  [16360, 17410],
  [17900, 18030],
  [18780, 18900],
  [19680, 19800],
  [21924, 22855],
  [23200, 23350],
  [25070, 25210],
].map(([startKhz, endKhz]) => ({ startKhz: startKhz!, endKhz: endKhz! }));

/**
 * AM broadcasters that b26 lists inside the aeronautical, maritime or ham
 * bands, where the band rule would tune a sideband and garble them (/ship
 * adversarial review, owner's choice: a named list). Matched on the folded
 * station name; add a name here when a season moves another one in.
 */
const BAND_BROADCASTERS =
  /\b(sound of hope|firedrake|voice of korea|radio tury|star-star bc|presidential pirate)\b/;

/**
 * The mode a result tunes in (D11, reopened at build: "USB outside the
 * broadcast bands" put 42% of b26's rows in USB, broadcasters included). AM
 * on long and medium wave and in the shortwave broadcast bands; in a ham band
 * what the dial would pick; USB in the aeronautical and maritime mobile bands;
 * AM anywhere else, where out-of-band broadcasters are. Morse rows tune CW,
 * and the AM broadcasters EiBi lists inside the mobile and ham bands tune AM.
 */
export function clickMode(khz: number, lang = "", station = ""): Mode {
  // EiBi's "-CW" language marks Morse (navy, channel markers): CW wherever it is.
  if (lang.split(",").some((c) => c.trim() === "-CW")) return "cw";
  if (khz < 1800 || inBand(khz, BROADCAST_BANDS) || BAND_BROADCASTERS.test(fold(station))) return "am";
  if (inBand(khz, HAM_BANDS)) return guessMode(khz);
  return inBand(khz, MOBILE_BANDS) ? "usb" : "am";
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** How long until `at`: "in 40 min", "in 3 h", "in 3 h 20 min". */
function until(at: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((at - now) / MINUTE));
  if (minutes < 60) return `in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `in ${h} h ${m} min` : `in ${h} h`;
}

/**
 * When a later broadcast starts, as a row shows it (design 7A): the time, and
 * how long until then under it ("in 40 min", or "tomorrow, in 9 h" once it's
 * past midnight UTC), two short lines rather than one too long for a row.
 */
export function startsParts(at: number, now: number): { time: string; until: string } {
  const tomorrow = Math.floor(at / DAY) > Math.floor(now / DAY);
  return { time: `${hhmm(at)} UTC`, until: `${tomorrow ? "tomorrow, " : ""}${until(at, now)}` };
}

/** The same start for a sentence: "starts at 19:00 UTC, in 40 min" (design 7A's note). */
export function startsSentence(at: number, now: number): string {
  const tomorrow = Math.floor(at / DAY) > Math.floor(now / DAY);
  return `starts ${tomorrow ? "tomorrow " : ""}at ${hhmm(at)} UTC, ${until(at, now)}`;
}
