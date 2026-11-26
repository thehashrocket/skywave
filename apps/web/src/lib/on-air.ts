/**
 * One schedule for every "what's on" (#148): EiBi's season schedule, Priyom's
 * numbers-station calendar and the hand-curated catalog (signal-stations.ts),
 * merged at read time into one list of Broadcast rows, sorted by frequency, so
 * the readout, waterfall, Strong signals, Find a station and the signal question
 * all read it through eibi.ts's and station-search.ts's own lookups. EiBi's
 * reception question reads EiBi's own rows instead (page.tsx `askableEibi`), so
 * this list's order never changes which station it asks about (#152). The
 * three sources stay in their own stores; Priyom's data is never copied into
 * EiBi's or exported (CC BY-NC-SA).
 *
 * Which source wins, per station (owner, #148 eng review):
 * - a catalog station with a Priyom designator: Priyom's transmissions only. Its
 *   EiBi rows are dropped, including slots Priyom doesn't list: a station
 *   Priyom has nothing for is off the air (D7). While Priyom's schedule is still
 *   loading nothing is shown for it (D4); with none to be had, or at a time the
 *   copy doesn't cover, its EiBi rows come back marked unconfirmed (D4, D13).
 * - a day/night station (The Pip, The Squeaky Wheel): EiBi's rows and hours on
 *   its catalog channels, as the catalog station (D8). EiBi's month windows are
 *   the best published switch times.
 * - any other catalog station: the catalog's channels and schedule. Its EiBi rows
 *   on frequencies the catalog doesn't list stay plain EiBi rows (WWV on 25 MHz, D7).
 * - everything else: EiBi, unchanged.
 *
 * Pure: the page passes the schedules it holds, and every lookup takes its time.
 */

import { type Broadcast, MATCH_KHZ } from "./eibi";
import { PRIYOM_ON_AIR_MS, priyomSpan, type PriyomTx } from "./priyom-schedule";
import type { Mode } from "./radio-types";
import { SIGNAL_STATIONS, type SignalStation } from "./signal-stations";
import { fold } from "./station-search";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ON_AIR_MINUTES = PRIYOM_ON_AIR_MS / MINUTE;

/** Where a row's facts come from; station-search.ts's SearchRow names the same three. */
export type Source = "eibi" | "priyom" | "catalog";

/** A row of the merged schedule. */
export type OnAirRow = Broadcast & {
  source: Source;
  /** The catalog station it is, for every row about one (fallback rows included). */
  slug?: string;
  /** The mode to tune, when the source gives one (Priyom, the catalog); else the page guesses. */
  mode?: Mode;
  /** Other names the station goes by (catalog aka, EiBi's names), found by search too. */
  aka?: readonly string[];
  /** Priyom's listed frequency, when the dial differs from it (an RTTY slot). */
  listedKhz?: number;
};

/**
 * Priyom's schedule as the page holds it: the copy and when the server fetched
 * it; undefined while the first answer is on its way; null when there's none.
 */
export type PriyomCopy = { transmissions: readonly PriyomTx[]; fetchedAt: number } | null | undefined;

const namesByCatalog = new WeakMap<readonly SignalStation[], Map<string, SignalStation>>();

/** Each catalog station by every EiBi name it has, folded; worked out once per catalog. */
function byEibiName(stations: readonly SignalStation[]): Map<string, SignalStation> {
  let map = namesByCatalog.get(stations);
  if (map) return map;
  map = new Map();
  for (const s of stations) for (const n of s.eibi ?? []) map.set(fold(n.trim()), s);
  namesByCatalog.set(stations, map);
  return map;
}

/** The catalog station an EiBi station name is, matched on the whole name (never a prefix: "WWVB Colorado" isn't WWV). */
export function stationNamed(name: string, stations: readonly SignalStation[] = SIGNAL_STATIONS): SignalStation | undefined {
  return byEibiName(stations).get(fold(name.trim()));
}

/**
 * EiBi station names that read as a numbers station ("... Numbers") but match no
 * catalog station: one EiBi renamed or added in a new season, whose season grid
 * would show as plain EiBi rows until its name joins the catalog (#148). Sorted, once each.
 */
export function unmappedNumbers(eibi: readonly Broadcast[], stations: readonly SignalStation[] = SIGNAL_STATIONS): string[] {
  const names = new Set(eibi.filter((b) => /\bNumbers\b/.test(b.station) && !stationNamed(b.station, stations)).map((b) => b.station));
  return [...names].sort();
}

/** The names a station is searched by besides its own. */
const akaOf = (s: SignalStation): readonly string[] => [...s.aka, ...(s.eibi ?? [])];

/** A Priyom transmission as a row: on its ten minutes only, on its dial. */
function priyomRow(tx: PriyomTx, s: SignalStation, like: Broadcast | undefined): OnAirRow | null {
  if (tx.khz === null || tx.mode === null) return null;
  const start = Math.floor((((tx.startMs % DAY) + DAY) % DAY) / MINUTE);
  const end = start + ON_AIR_MINUTES;
  return {
    khz: tx.khz,
    start,
    end: end > 1440 ? end - 1440 : end,
    days: "",
    station: s.name,
    // RTTY reads as "Digital data", as EiBi's data rows do; otherwise the station's
    // EiBi language and target, so the filters treat it as they did EiBi's rows.
    lang: tx.data ? "-TY" : (like?.lang ?? ""),
    target: like?.target ?? "",
    validFromMs: tx.startMs,
    validToMs: tx.startMs + PRIYOM_ON_AIR_MS,
    source: "priyom",
    slug: s.slug,
    mode: tx.mode,
    aka: akaOf(s),
    ...(tx.listedKhz !== undefined && { listedKhz: tx.listedKhz }),
  };
}

/**
 * The merged schedule (see the file comment). Rows are sorted by frequency, as
 * eibi.ts's lookups need. Within a frequency the catalog's and Priyom's rows come
 * before EiBi's (#152), so with no region to rank by a station with a page leads
 * (WWV, not PPE, on 10 MHz); rows standing in for Priyom's are EiBi's, so they
 * stay behind. Each source keeps its own order. `rankBroadcasts` ranks by region
 * on top of this: with one, the stations aimed there still lead (ItalCable on
 * 10 MHz for Europe).
 */
export function onAirSchedule(
  eibi: readonly Broadcast[],
  priyom: PriyomCopy,
  stations: readonly SignalStation[] = SIGNAL_STATIONS,
): OnAirRow[] {
  const rows: OnAirRow[] = [];
  /** Each catalog station's first EiBi row: its language and target for rows built for it. */
  const first = new Map<string, Broadcast>();
  /** EiBi rows of Priyom stations, for the fallback. */
  const priyomRows = new Map<string, Broadcast[]>();

  for (const b of eibi) {
    const s = stationNamed(b.station, stations);
    if (!s || s.schedule.kind === "defunct") {
      rows.push({ ...b, source: "eibi" });
      continue;
    }
    if (!first.has(s.slug)) first.set(s.slug, b);
    if (s.priyom) {
      const held = priyomRows.get(s.slug);
      if (held) held.push(b);
      else priyomRows.set(s.slug, [b]);
      continue;
    }
    const channel = s.channels.find((c) => Math.abs(c.khz - b.khz) <= MATCH_KHZ);
    // Off every catalog channel: EiBi's row stands, as EiBi's (WWV on 25 MHz).
    if (!channel) rows.push({ ...b, source: "eibi" });
    // A day/night station: EiBi's hours, the catalog's station and channel.
    else if (s.schedule.kind === "dayNight")
      rows.push({ ...b, khz: channel.khz, station: s.name, source: "catalog", slug: s.slug, mode: channel.mode, aka: akaOf(s) });
    // Any other catalog station: its own rows below replace EiBi's.
  }

  for (const s of stations) {
    if (s.priyom || s.schedule.kind === "defunct" || s.schedule.kind === "dayNight") continue;
    const like = first.get(s.slug);
    const base = { station: s.name, lang: like?.lang ?? "", target: like?.target ?? "", source: "catalog" as const, slug: s.slug, aka: akaOf(s) };
    if (s.schedule.kind === "always")
      for (const c of s.channels) rows.push({ ...base, khz: c.khz, start: 0, end: 1440, days: "", mode: c.mode });
    else if (s.schedule.kind === "windows")
      for (const w of s.schedule.windows) {
        const mode = s.channels.find((c) => c.khz === w.khz)?.mode;
        rows.push({ ...base, khz: w.khz, start: w.startUtc, end: w.endUtc, days: w.days ?? "", ...(mode && { mode }) });
      }
    // Irregular stations without Priyom are never on now.
  }

  // Priyom's stations, in Priyom's three states.
  const priyomStations = stations.filter((s) => s.priyom && s.schedule.kind !== "defunct");
  /** Each Priyom station's EiBi rows, marked unconfirmed, within `bounds`. */
  const fallback = (bounds: { validFromMs?: number; validToMs?: number }) => {
    for (const s of priyomStations)
      for (const b of priyomRows.get(s.slug) ?? [])
        rows.push({ ...b, station: s.name, ...bounds, unconfirmed: true, source: "eibi", slug: s.slug, aka: akaOf(s) });
  };
  if (priyom === null) {
    // None to be had: EiBi's season rows stand in, marked (D4).
    fallback({});
  } else if (priyom !== undefined) {
    // A copy: its transmissions, and outside the span it covers EiBi's rows, marked (D13).
    const byDesignator = new Map(priyomStations.map((s) => [s.priyom!, s]));
    for (const tx of priyom.transmissions) {
      const s = byDesignator.get(tx.station);
      const row = s && priyomRow(tx, s, first.get(s.slug));
      if (row) rows.push(row);
    }
    const span = priyomSpan(priyom.fetchedAt);
    fallback({ validToMs: span.fromMs });
    fallback({ validFromMs: span.toMs });
  }
  // Still loading (undefined): nothing for them, rather than EiBi's season grid (D4).

  return rows.sort((a, b) => a.khz - b.khz || Number(a.source === "eibi") - Number(b.source === "eibi"));
}
