import { LANGUAGES } from "./eibi-languages";

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
  /** Dates it runs between, "DDMM" each, when the file gives them. */
  from?: string;
  to?: string;
};

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
 * A season's CSV (sked-a26.csv, sked-b26.csv...) as broadcasts sorted by
 * frequency. Drops inactive entries, ones for the other season, and
 * alternative or spurious frequencies. Throws if the text isn't the
 * schedule, so a moved or broken file never replaces a good copy.
 */
export function parseEibi(text: string, season: string): Broadcast[] {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.startsWith("kHz:")) throw new Error("Not an EiBi schedule: the header is missing.");
  const winter = season.startsWith("b");
  const out: Broadcast[] = [];
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
    // given; 90 and up are the same for utility stations.
    const persistence = Number(f[8]) % 90;
    if (persistence === 8 || (persistence === 4 && !winter) || (persistence === 5 && winter)) continue;
    const from = f[9]?.trim() ?? "";
    const to = f[10]?.trim() ?? "";
    const b: Broadcast = { khz, start, end, days, station, lang: f[5]!.trim(), target: f[6]!.trim() };
    // A start date on a lasting entry is only when it began; an end date ("[0326]",
    // the last time it was heard, isn't one) still ends it.
    const fromDate = dateIn(from);
    const toDate = dateIn(to);
    if (persistence === 6 && fromDate) b.from = fromDate;
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

/** Broadcasts on one frequency. */
export type Channel = { khz: number; broadcasts: Broadcast[] };

/**
 * What's scheduled between two frequencies now, one entry per listed
 * frequency, lowest first. The same station in the same language is listed
 * once (EiBi lists each transmitter site).
 */
export function scheduledBetween(schedule: readonly Broadcast[], loKhz: number, hiKhz: number, ms: number): Channel[] {
  const out: Channel[] = [];
  for (let i = firstAtOrAbove(schedule, loKhz); i < schedule.length && schedule[i]!.khz <= hiKhz; i++) {
    const b = schedule[i]!;
    if (!onAirAt(b, ms)) continue;
    let channel = out.at(-1);
    if (channel?.khz !== b.khz) out.push((channel = { khz: b.khz, broadcasts: [] }));
    if (!channel.broadcasts.some((o) => o.station === b.station && o.lang === b.lang)) channel.broadcasts.push(b);
  }
  return out;
}

/**
 * How close a listed frequency must be to count as the one tuned: the scan and
 * the wheel land on whole kilohertz, and a few stations are listed off the grid.
 */
export const MATCH_KHZ = 0.5;

/** What's scheduled on a frequency now, nearest listing first. */
export function scheduledOn(schedule: readonly Broadcast[], khz: number, ms: number): Broadcast[] {
  return scheduledBetween(schedule, khz - MATCH_KHZ, khz + MATCH_KHZ, ms)
    .sort((a, b) => Math.abs(a.khz - khz) - Math.abs(b.khz - khz))
    .flatMap((c) => c.broadcasts);
}

/** "F,E" as "French, English". Unknown codes are left out. */
export function languageNames(codes: string): string {
  return codes
    .split(",")
    .map((c) => LANGUAGES[c.trim()])
    .filter(Boolean)
    .join(", ");
}

/** One broadcast as "KBS World Radio · English". */
export function describe(b: Broadcast): string {
  const lang = languageNames(b.lang);
  return lang ? `${b.station} · ${lang}` : b.station;
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
