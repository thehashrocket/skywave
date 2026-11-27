import { LANGUAGES } from "./eibi-languages";
import { siteKey } from "./eibi-sites";
import { type BroadRegion, regionsOf } from "./eibi-targets";

/**
 * The EiBi shortwave schedule (http://www.eibispace.de/dx/): who's scheduled
 * on a frequency at a UTC time. A schedule, not a log: a listed station may be
 * off air or not heard where the receiver is, and an unlisted one may be on.
 *
 * Shared by the server, which fetches and parses the season's file, and the
 * page, which matches it against the tuned frequency and the clock.
 */

/** One scheduled broadcast. */
export type Broadcast = {
  khz: number;
  /** UTC minutes from midnight; `end` is 1440 for "2400". */
  start: number;
  end: number;
  /** EiBi's days field: blank for daily, "Mo-Fr", "1245", "1.Sa", "15Sep", "irr"... */
  days: string;
  station: string;
  /** Language codes, comma-separated ("F,E"); see `languageNames`. */
  lang: string;
  /** Target-area code ("Eu", "NAm"...). */
  target: string;
  /**
   * Dates it runs between, "DDMM" each, any year: a window that may wrap New
   * Year. `from` is kept only as half of a window (see parseEibi); `to` alone
   * ends a lasting entry.
   */
  from?: string;
  to?: string;
  /**
   * Never in EiBi's own rows. A row on-air.ts builds can be bounded to moments
   * (Unix ms, half-open): a Priyom slot to its ten minutes, a fallback row to the
   * times Priyom's copy doesn't cover (#148).
   */
  validFromMs?: number;
  validToMs?: number;
  /** A season-schedule row standing in while Priyom's schedule can't be had (#148): shown marked, never asked about. */
  unconfirmed?: true;
};

/**
 * A broadcast as the server keeps it: with the row's country (EiBi's ITU
 * column) and transmitter site key (lib/eibi-sites.ts; absent when the
 * Remarks column isn't a site code). Never sent to the page (#72 eng review,
 * D7/D13), which gets plain `Broadcast`s.
 */
export type ListedBroadcast = Broadcast & { country: string; site?: string };

/** A listed broadcast as the page gets it. */
export function forPage({ country: _c, site: _s, ...b }: ListedBroadcast): Broadcast {
  return b;
}

/** The season a moment falls in: "a26" (summer, from the last Sunday of March) or "b26" (winter, from the last Sunday of October). */
export function seasonFor(ms: number): string {
  const year = new Date(ms).getUTCFullYear();
  const yy = (y: number) => String(y % 100).padStart(2, "0");
  if (ms >= lastSunday(year, 9)) return `b${yy(year)}`;
  if (ms >= lastSunday(year, 2)) return `a${yy(year)}`;
  return `b${yy(year - 1)}`;
}

function lastSunday(year: number, month0: number): number {
  const last = new Date(Date.UTC(year, month0 + 1, 0));
  return Date.UTC(year, month0, last.getUTCDate() - last.getUTCDay());
}

/** Where a season's schedule is published. eibispace.de's certificate isn't kept current, so plain http. */
export function scheduleUrl(season: string): string {
  return `http://www.eibispace.de/dx/sked-${season}.csv`;
}

// Entries that aren't a station on the air at its listed times.
const NOT_ON_AIR = new Set(["alt", "harm", "imod", "spur", "Ram", "Haj"]);

// "DDMM", sometimes followed by a last-heard note ("2012[1121]").
const DATE = /^((?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2]))(?:\[\d{4}\])?$/;
const dateIn = (field: string) => DATE.exec(field)?.[1];

/**
 * Whether a "DDMM" end date is the season's last day, give or take two days
 * (the day before the last Sunday of March or October, the 24th to the
 * 30th, so the 22nd to the 30th): how EiBi ends an entry that runs the season out. Never the 31st,
 * which ends a month window (E07's "0103;3103").
 */
function endsSeason(ddmm: string, season: string): boolean {
  const year = 2000 + Number(season.slice(1));
  const last = season.startsWith("b") ? lastSunday(year + 1, 2) - DAY : lastSunday(year, 9) - DAY;
  const end = new Date(last);
  const day = Number(ddmm.slice(0, 2));
  return Number(ddmm.slice(2)) === end.getUTCMonth() + 1 && day < 31 && Math.abs(day - end.getUTCDate()) <= 2;
}

/**
 * A season's CSV (sked-a26.csv, sked-b26.csv...) as broadcasts sorted by
 * frequency. Drops inactive entries, ones for the other season, and
 * alternative or spurious frequencies. Throws if the text isn't the
 * schedule, so a moved or broken file never replaces a good copy.
 */
export function parseEibi(text: string, season: string): ListedBroadcast[] {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.startsWith("kHz:")) throw new Error("Not an EiBi schedule: the header is missing.");
  const winter = season.startsWith("b");
  const out: ListedBroadcast[] = [];
  for (const line of lines.slice(1)) {
    const f = line.split(";");
    if (f.length < 9) continue;
    const khz = Number(f[0]);
    const time = /^(\d\d)(\d\d)-(\d\d)(\d\d)$/.exec(f[1]!);
    const station = f[4]!.trim();
    if (!Number.isFinite(khz) || khz < 10 || khz > 30_000 || !time || !station) continue;
    const start = Number(time[1]) * 60 + Number(time[2]);
    const end = Number(time[3]) * 60 + Number(time[4]);
    if (start > 1440 || end > 1440) continue;
    const days = f[2]!.trim();
    if (NOT_ON_AIR.has(days)) continue;
    // Persistence: 8 is inactive, 4 winter only, 5 summer only, 6 between the dates
    // given (a start date alone counts only here); 90 and up are the same for
    // utility stations. Both dates make a window at any persistence (below).
    const persistence = Number(f[8]) % 90;
    if (persistence === 8 || (persistence === 4 && !winter) || (persistence === 5 && winter)) continue;
    const from = f[9]?.trim() ?? "";
    const to = f[10]?.trim() ?? "";
    const country = f[3]!.trim();
    const b: ListedBroadcast = { khz, start, end, days, station, lang: f[5]!.trim(), target: f[6]!.trim(), country };
    const site = siteKey(country, f[7] ?? "");
    if (site !== undefined) b.site = site;
    // A start date with an end date is a window, whatever the persistence: seasonal
    // rows give one row per month range (The Pip's Nov-Feb and Mar-Apr hours, #149).
    // A start date alone on a lasting entry is only when it began; an end date
    // ("[0326]", the last time it was heard, isn't one) still ends it. So does a
    // start date beside an end on the season's last day: "0101;2803" in B26 began
    // in January and runs the season out, not a January-March window.
    // Taken as written, including slips: B26's "2514;1320-1400;...;VFF Iqaluit
    // Radio;...;0701;3110" (beside its 0107-3110 rows, likely meant July) reads
    // as 7 Jan-31 Oct and is named on 2514 kHz from 7 Jan (#149 review).
    const fromDate = dateIn(from);
    const toDate = dateIn(to);
    const isWindow = toDate !== undefined && !endsSeason(toDate, season);
    if (fromDate && (persistence === 6 || isWindow)) b.from = fromDate;
    if (toDate) b.to = toDate;
    out.push(b);
  }
  if (out.length === 0) throw new Error("Not an EiBi schedule: no broadcasts in it.");
  return out.sort((a, b) => a.khz - b.khz);
}

const DAY = 86_400_000;
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Monday is 1, Sunday 7, as EiBi numbers them. */
function isoDay(d: Date) {
  return ((d.getUTCDay() + 6) % 7) + 1;
}

/** "Mo-Fr", "Tu,Th", "SaSu", "We-Mo" as ISO day numbers, or null if it isn't a list of days. */
function weekdays(spec: string): Set<number> | null {
  const set = new Set<number>();
  for (const part of spec.split(",")) {
    const range = /^([A-Z][a-z])-([A-Z][a-z])$/.exec(part);
    if (range) {
      const a = WEEKDAYS.indexOf(range[1]!);
      const b = WEEKDAYS.indexOf(range[2]!);
      if (a < 0 || b < 0) return null;
      // Ranges can wrap the weekend: "We-Mo".
      for (let i = a; ; i = (i + 1) % 7) {
        set.add(i + 1);
        if (i === b) break;
      }
      continue;
    }
    if (!/^([A-Z][a-z])+$/.test(part)) return null;
    for (const name of part.match(/[A-Z][a-z]/g)!) {
      const i = WEEKDAYS.indexOf(name);
      if (i < 0) return null;
      set.add(i + 1);
    }
  }
  return set;
}

/**
 * Whether the days field allows a broadcast that starts on this UTC day.
 * Anything it can't read ("irr", "test", "altFr"...) counts as on: a name
 * shown for an irregular station is better than one missing for a daily one.
 */
export function onDay(spec: string, day: Date): boolean {
  if (!spec) return true;
  const iso = isoDay(day);
  if (/^[1-7]+$/.test(spec)) return spec.includes(String(iso));
  const nth = /^([1-5])\.([A-Z][a-z])$/.exec(spec);
  if (nth) return WEEKDAYS.indexOf(nth[2]!) + 1 === iso && Math.ceil(day.getUTCDate() / 7) === Number(nth[1]);
  const last = /^Last([1-7])$/.exec(spec);
  if (last) return Number(last[1]) === iso && new Date(day.getTime() + 7 * DAY).getUTCMonth() !== day.getUTCMonth();
  const date = /^(\d{1,2})([A-Z][a-z]{2})$/.exec(spec);
  if (date && MONTHS.includes(date[2]!))
    return Number(date[1]) === day.getUTCDate() && MONTHS.indexOf(date[2]!) === day.getUTCMonth();
  return weekdays(spec)?.has(iso) ?? true;
}

/** Whether a day falls between two "DDMM" dates, either of them open, across a new year too. */
function inDates(from: string | undefined, to: string | undefined, day: Date): boolean {
  const key = (ddmm: string) => Number(ddmm.slice(2)) * 100 + Number(ddmm.slice(0, 2));
  const today = (day.getUTCMonth() + 1) * 100 + day.getUTCDate();
  if (from && to) {
    const [a, b] = [key(from), key(to)];
    return a <= b ? today >= a && today <= b : today >= a || today <= b;
  }
  if (from) return today >= key(from);
  // An end date alone, on a lasting entry. A season is about seven months and a
  // winter one runs past New Year, so an end still to come is under eight months
  // away; one further off (going round the year) has passed.
  if (to) {
    const end = Date.UTC(day.getUTCFullYear(), Number(to.slice(2)) - 1, Number(to.slice(0, 2)));
    const ahead = (end - Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())) / DAY;
    return (ahead + 366) % 366 <= 240;
  }
  return true;
}

/** Whether a broadcast is scheduled at this moment. */
export function onAirAt(b: Broadcast, ms: number): boolean {
  if ((b.validFromMs !== undefined && ms < b.validFromMs) || (b.validToMs !== undefined && ms >= b.validToMs)) return false;
  const now = new Date(ms);
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  let startDay = now;
  if (b.start < b.end) {
    if (minute < b.start || minute >= b.end) return false;
  } else if (b.start > b.end) {
    // Over midnight ("2330-0450"): after midnight it began the day before.
    if (minute < b.start && minute >= b.end) return false;
    if (minute < b.end) startDay = new Date(ms - DAY);
  }
  return onDay(b.days, startDay) && inDates(b.from, b.to, startDay);
}

/** The first broadcast in a sorted schedule at or above this frequency. */
function firstAtOrAbove(schedule: readonly Broadcast[], khz: number): number {
  let lo = 0;
  let hi = schedule.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (schedule[mid]!.khz < khz) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Every listing between two frequencies on the air now, lowest frequency first. */
export function onAirBetween<B extends Broadcast>(
  schedule: readonly B[],
  loKhz: number,
  hiKhz: number,
  ms: number,
): B[] {
  const out: B[] = [];
  for (let i = firstAtOrAbove(schedule, loKhz); i < schedule.length && schedule[i]!.khz <= hiKhz; i++) {
    if (onAirAt(schedule[i]!, ms)) out.push(schedule[i]!);
  }
  return out;
}

/** Broadcasts on one frequency. */
export type Channel<B extends Broadcast = Broadcast> = { khz: number; broadcasts: B[] };

/** Whether a broadcast is aimed at a broad region. */
const aimedAt = (b: Broadcast, region: BroadRegion) => regionsOf(b.target).includes(region);

/**
 * What's scheduled between two frequencies now, one entry per listed
 * frequency, lowest first. The same station in the same language is listed
 * once (EiBi lists each transmitter site), where it first appears in `schedule`;
 * with a `region`, the row kept is one aimed there if any is (#115), so a
 * station with a site aimed elsewhere listed first still ranks as aimed.
 */
export function scheduledBetween<B extends Broadcast>(
  schedule: readonly B[],
  loKhz: number,
  hiKhz: number,
  ms: number,
  region?: BroadRegion,
): Channel<B>[] {
  const out: Channel<B>[] = [];
  for (const b of onAirBetween(schedule, loKhz, hiKhz, ms)) {
    let channel = out.at(-1);
    if (channel?.khz !== b.khz) out.push((channel = { khz: b.khz, broadcasts: [] }));
    const i = channel.broadcasts.findIndex((o) => o.station === b.station && o.lang === b.lang);
    if (i < 0) channel.broadcasts.push(b);
    else if (region && !aimedAt(channel.broadcasts[i]!, region) && aimedAt(b, region)) channel.broadcasts[i] = b;
  }
  return out;
}

/**
 * How close a listed frequency must be to count as the one tuned: the scan and
 * the wheel land on whole kilohertz, and a few stations are listed off the grid.
 */
export const MATCH_KHZ = 0.5;

/**
 * Broadcasts with, on each listed frequency, the ones aimed at `region` first
 * (#115): where the audio comes from, so the one a listener there most likely
 * hears leads. Frequencies keep their order (a list from `listedOn` stays
 * nearest first); within one, ties and every broadcast when no region is
 * known keep their order.
 */
export function rankBroadcasts<B extends Broadcast>(broadcasts: readonly B[], region?: BroadRegion): B[] {
  if (!region) return [...broadcasts];
  const firstAt = new Map<number, number>();
  broadcasts.forEach((b, i) => firstAt.has(b.khz) || firstAt.set(b.khz, i));
  const key = (b: Broadcast) => firstAt.get(b.khz)! * 2 + (aimedAt(b, region) ? 0 : 1);
  return broadcasts
    .map((b, i) => ({ b, i }))
    .sort((x, y) => key(x.b) - key(y.b) || x.i - y.i)
    .map(({ b }) => b);
}

/**
 * What's scheduled on a frequency now, nearest listing first, each station in
 * the schedule's order: EiBi's file order, or in the merged list the catalog's
 * and Priyom's rows first (on-air.ts, #152). With `region`, a row aimed there is
 * kept for it (see scheduledBetween). `scheduledOn` ranks this; `eibiTransmitter` needs both.
 */
export function listedOn<B extends Broadcast>(schedule: readonly B[], khz: number, ms: number, region?: BroadRegion): B[] {
  return scheduledBetween(schedule, khz - MATCH_KHZ, khz + MATCH_KHZ, ms, region)
    .sort((a, b) => Math.abs(a.khz - khz) - Math.abs(b.khz - khz))
    .flatMap((c) => c.broadcasts);
}

/**
 * What's scheduled on a frequency now, nearest listing first; on one listing,
 * those aimed at `region` (where the audio comes from) first.
 */
export function scheduledOn<B extends Broadcast>(schedule: readonly B[], khz: number, ms: number, region?: BroadRegion): B[] {
  return rankBroadcasts(listedOn(schedule, khz, ms, region), region);
}

/**
 * A language code's name, or undefined. Own keys only: a code like
 * "constructor" (tampered storage, an odd upstream code) mustn't name itself
 * after Object's.
 */
const languageName = (code: string): string | undefined =>
  Object.hasOwn(LANGUAGES, code) ? LANGUAGES[code] : undefined;

/** "F,E" as "French, English". Unknown codes are left out. */
export function languageNames(codes: string): string {
  return codes
    .split(",")
    .map((c) => languageName(c.trim()))
    .filter(Boolean)
    .join(", ");
}

/** The mark on a season-schedule row standing in for Priyom's (#148). */
export const UNCONFIRMED = "season schedule, not confirmed";

/** One broadcast as "KBS World Radio · English", marked when it stands in for Priyom's. */
export function describe(b: Broadcast): string {
  const lang = languageNames(b.lang);
  const text = lang ? `${b.station} · ${lang}` : b.station;
  return b.unconfirmed ? `${text} (${UNCONFIRMED})` : text;
}


/**
 * A label short enough to sit over a waterfall: the first station's name and
 * how many others share the frequency ("Voice of Turkey +1"), without the
 * languages, which the readout gives for the tuned one. Null if nothing is.
 */
export function shortLabel(broadcasts: readonly Broadcast[]): string | null {
  const first = broadcasts[0];
  if (!first) return null;
  // A row standing in for Priyom's: "E11 (unconfirmed)", the readout's mark shortened
  // for the waterfall, where there's no tooltip to explain a symbol (owner, #148).
  const name = first.unconfirmed ? `${first.station} (unconfirmed)` : first.station;
  return broadcasts.length > 1 ? `${name} +${broadcasts.length - 1}` : name;
}

/** What's scheduled on a frequency, as a line of text and, for a tooltip, every broadcast. */
export type StationLine = { text: string; all: string };

/**
 * A line for what's scheduled on a frequency: the first broadcast, and how
 * many more share it. Null if nothing is.
 */
export function stationLine(broadcasts: readonly Broadcast[]): StationLine | null {
  const first = broadcasts[0];
  if (!first) return null;
  const more = broadcasts.length - 1;
  return {
    text: more > 0 ? `${describe(first)} +${more} more` : describe(first),
    all: broadcasts.map(describe).join("\n"),
  };
}

/** EiBi's codes for what isn't speech: time signals, Morse, data, music, empty carriers, aircraft data. */
export const NON_VOICE: ReadonlySet<string> = new Set(["-TS", "-CW", "-TY", "-MX", "-EC", "-HF"]);

/** Programme names in EiBi's language table (Vatican Radio's Angelus...), not languages: left out of the picker. */
const PROGRAMMES: ReadonlySet<string> = new Set(["Ang", "Aud", "Ros", "Ves"]);

/** A language field's codes: "F, E" is ["F", "E"]. */
export function languageCodes(lang: string): string[] {
  return lang
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

/** A broadcast whose codes are all non-voice ones (a time signal, Morse, data). Blank isn't. */
export function isNonVoice(lang: string): boolean {
  const codes = languageCodes(lang);
  return codes.length > 0 && codes.every((c) => NON_VOICE.has(c));
}

/**
 * The language filter (#110): codes picked (none is Any) and whether
 * non-voice broadcasts show. Non-voice follows the toggle with or without a
 * language picked (eng D7); otherwise a broadcast matches if any of its codes
 * is picked ("F,E" matches English), and one with no language listed only
 * under Any.
 */
export type LanguageFilter = { codes: readonly string[]; nonVoice: boolean };

export function speaks(lang: string, filter: LanguageFilter): boolean {
  if (isNonVoice(lang)) return filter.nonVoice;
  if (filter.codes.length === 0) return true;
  return languageCodes(lang).some((c) => filter.codes.includes(c));
}

/** One entry in the language picker: a name and every code EiBi gives it (Hmong is HM and HMQ). */
export type LanguageChoice = { name: string; codes: string[]; stale: boolean };

/** The names of the choices any of whose codes are picked, in the choices' order. */
export const pickedNames = (choices: readonly LanguageChoice[], picked: readonly string[]) =>
  choices.filter((c) => c.codes.some((code) => picked.includes(code))).map((c) => c.name);

/** The picker's head, in the issue's order (#110), Mandarin beside Chinese since it's EiBi's commonest. */
const COMMON = ["English", "Spanish", "French", "Arabic", "Mandarin", "Chinese", "Russian", "Portuguese", "German"];

/** Every code by name, from the table: picking a name picks them all. */
const CODES_BY_NAME = new Map<string, string[]>();
for (const [code, name] of Object.entries(LANGUAGES))
  if (!NON_VOICE.has(code) && !PROGRAMMES.has(code))
    CODES_BY_NAME.set(name, [...(CODES_BY_NAME.get(name) ?? []), code]);

// The schedule's languages, worked out once per schedule (it's refetched every few hours, not every minute).
const choicesBySchedule = new WeakMap<readonly Broadcast[], LanguageChoice[]>();

function scheduleChoices(broadcasts: readonly Broadcast[]): LanguageChoice[] {
  const held = choicesBySchedule.get(broadcasts);
  if (held) return held;
  const names = new Set<string>();
  for (const b of broadcasts)
    for (const code of languageCodes(b.lang))
      if (!NON_VOICE.has(code) && !PROGRAMMES.has(code)) names.add(languageName(code) ?? code);
  const out = [...names].map((name) => ({ name, codes: CODES_BY_NAME.get(name) ?? [name], stale: false }));
  const rank = (name: string) => (COMMON.includes(name) ? COMMON.indexOf(name) : COMMON.length);
  out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  choicesBySchedule.set(broadcasts, out);
  return out;
}

/**
 * The language picker's entries (eng D5): languages the schedule uses, one per
 * name, the common ones first and the rest A to Z; programme names and the
 * non-voice codes are left out, and a code with no name shows as itself.
 * Saved codes the schedule doesn't use are added at the end, marked stale, so
 * a choice from last season can still be seen and unticked (eng D8).
 */
export function languageChoices(broadcasts: readonly Broadcast[], saved: readonly string[] = []): LanguageChoice[] {
  const base = scheduleChoices(broadcasts);
  const known = new Set(base.flatMap((c) => c.codes));
  const stale = new Map<string, LanguageChoice>();
  for (const code of saved) {
    if (known.has(code)) continue;
    const name = languageName(code) ?? code;
    if (!stale.has(name)) stale.set(name, { name, codes: CODES_BY_NAME.get(name) ?? [code], stale: true });
  }
  return stale.size ? [...base, ...stale.values()] : base;
}
