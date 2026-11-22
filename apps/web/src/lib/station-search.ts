import { type Broadcast, languageNames, onAirAt } from "./eibi";

const DAY_MIN = 24 * 60;
const MINUTE = 60_000;

/** Fewest characters worth searching on: one letter matches half the schedule. */
export const MIN_QUERY = 2;

/** One frequency a station uses, with the languages heard there. */
export type StationFreq = { khz: number; lang: string; target: string };

export type StationMatch = {
  station: string;
  /** Frequencies it's on the air on now, lowest first. Empty when it's off. */
  now: StationFreq[];
  /** When it's off: its next start in the coming day, if any. */
  next?: { khz: number; lang: string; at: number };
};

/** Lowercase without accents, so "radio france" finds "Radio Fránce". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Every word of the query appears somewhere in the name, in any order. */
function matches(name: string, words: readonly string[]): boolean {
  const folded = fold(name);
  return words.every((w) => folded.includes(w));
}

/** The next time, after `ms`, a broadcast starts and its days allow it, within a day. */
function nextStart(b: Broadcast, ms: number): number | null {
  const now = new Date(ms);
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ahead = (b.start - minute + DAY_MIN) % DAY_MIN || DAY_MIN;
  const at = midnight + (minute + ahead) * MINUTE;
  return onAirAt(b, at) ? at : null;
}

/** Adds a language to a comma list once. */
const addLang = (list: string, lang: string) =>
  list
    .split(",")
    .concat(lang.split(","))
    .map((c) => c.trim())
    .filter((c, i, all) => c && all.indexOf(c) === i)
    .join(",");

/**
 * Stations in the EiBi schedule whose names hold every word of the query,
 * one entry per station: those on the air now first, then the rest by when
 * they're next on, then by name. Each lists the frequencies it's on now, one
 * per frequency with its languages together (EiBi lists each transmitter).
 */
export function searchStations(schedule: readonly Broadcast[], query: string, ms: number): StationMatch[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.join("").length < MIN_QUERY) return [];

  const byName = new Map<string, StationMatch>();
  for (const b of schedule) {
    if (!matches(b.station, words)) continue;
    let match = byName.get(b.station);
    if (!match) byName.set(b.station, (match = { station: b.station, now: [] }));
    if (onAirAt(b, ms)) {
      const same = match.now.find((f) => f.khz === b.khz);
      if (same) same.lang = addLang(same.lang, b.lang);
      else match.now.push({ khz: b.khz, lang: b.lang, target: b.target });
      continue;
    }
    const at = nextStart(b, ms);
    if (at !== null && (!match.next || at < match.next.at)) match.next = { khz: b.khz, lang: b.lang, at };
  }

  const startsWith = (m: StationMatch) => fold(m.station).startsWith(words[0]!);
  return [...byName.values()]
    .map((m) => (m.now.length ? { ...m, now: m.now.sort((a, b) => a.khz - b.khz), next: undefined } : m))
    .sort(
      (a, b) =>
        Number(b.now.length > 0) - Number(a.now.length > 0) ||
        (a.now.length ? 0 : (a.next?.at ?? Infinity) - (b.next?.at ?? Infinity)) ||
        Number(startsWith(b)) - Number(startsWith(a)) ||
        a.station.localeCompare(b.station),
    );
}

/** "French, English", or the codes as EiBi gives them when none are known. */
export function langLabel(codes: string): string {
  return languageNames(codes) || codes;
}
