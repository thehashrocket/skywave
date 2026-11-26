import { after } from "next/server";
import { forPage, parseEibi, scheduleUrl, seasonFor, type Broadcast, type ListedBroadcast } from "@/lib/eibi";
import { unmappedNumbers } from "@/lib/on-air";
import { parseSites, SITES_URL, sitesFromJson, type SiteTable } from "@/lib/eibi-sites";
import { targetName, type TargetTable } from "@/lib/eibi-targets";
import snapshot from "../eibi-snapshot.json";
import { readCapped } from "../read-capped";
import { publicProcedure, router } from "../trpc";

// EiBi updates its file every few days; once a day is plenty.
const TTL_MS = 24 * 60 * 60_000;
// After a failed fetch, serve what we have and ask again in ten minutes.
const RETRY_AFTER_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
// The real file is about 0.5 MB.
const MAX_BYTES = 3_000_000;

export type Schedule = {
  season: string;
  broadcasts: Broadcast[];
  /** The copy bundled with this app, served because eibispace.de couldn't be reached. */
  bundled: boolean;
  /**
   * Names for the target codes the broadcasts use ("Eu" → "Europe"), from the
   * README's lists bundled in the snapshot (station search, re-check D5). A
   * code with no name is left out.
   */
  targetNames: Record<string, string>;
};

/**
 * The schedule as the server keeps it: `broadcasts` for the page, and the
 * same rows with their country and site in `listed`, for reports.submit.
 * Both are made once per refresh (#72 eng review, D13).
 */
export type ListedSchedule = Schedule & { listed: ListedBroadcast[] };

type Cached = ListedSchedule & { fetchedAt: number };

/** Names for the target codes these broadcasts use, from the bundled README lists. */
function namesFor(broadcasts: readonly Broadcast[], targets: TargetTable | undefined): Record<string, string> {
  const names: Record<string, string> = {};
  if (!targets) return names;
  for (const { target } of broadcasts) {
    if (Object.hasOwn(names, target)) continue;
    const name = targetName(targets, target);
    if (name) names[target] = name;
  }
  return names;
}

function fromCsv(csv: string, season: string, targets: TargetTable | undefined) {
  const listed = parseEibi(csv, season);
  const broadcasts = listed.map(forPage);
  return { season, listed, broadcasts, targetNames: namesFor(broadcasts, targets) };
}

type Options = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Keeps a background refresh running after the response is sent. */
  defer?: (task: Promise<unknown>) => void;
  /** The fallback copy: the season it's for and the file's text. */
  bundled?: { season: string; csv: string };
  /** The target names bundled in the snapshot (README sections II and III). */
  targets?: TargetTable;
};

/**
 * One of EiBi's files as text, the same way for the schedule and the site
 * table: no redirects, the timeout, a size cap, and Latin-1 (both files are).
 */
async function fetchLatin1(fetchImpl: typeof fetch, url: string, what: string): Promise<string> {
  const res = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "skywave (+https://github.com/thehashrocket/skywave)" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${what} request failed: HTTP ${res.status}`);
  return (await readCapped(res, MAX_BYTES, `The ${what}`)).toString("latin1");
}

/**
 * The season's EiBi schedule, fetched at most once a day and shared between
 * concurrent callers, like `receiverSource`. It never fails: until a fetch
 * succeeds, and whenever eibispace.de is down with nothing fetched yet, it
 * serves the copy bundled with the app. Only the first request on a fresh
 * server waits for eibispace.de; later ones get the cached copy while any
 * refresh runs in the background. A new season counts as expired.
 */
export function scheduleSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  defer = after,
  bundled = snapshot,
  targets = snapshot.targets,
}: Options = {}) {
  let cached: Cached | null = null;
  let fallback: Cached | null = null;
  let inflight: Promise<Cached> | null = null;
  let lastFailureAt: number | null = null;

  async function refresh(): Promise<Cached> {
    const season = seasonFor(now());
    const csv = await fetchLatin1(fetchImpl, scheduleUrl(season), "EiBi schedule");
    const schedule = fromCsv(csv, season, targets);
    // A numbers station EiBi lists under a name the catalog doesn't know: its season
    // grid would show as plain EiBi rows (#148). Said once per fetch, nothing changed.
    const unmapped = unmappedNumbers(schedule.listed);
    if (unmapped.length)
      console.warn(
        `stations.schedule: ${season} lists numbers stations no catalog station names (add them to an eibi field in signal-stations.ts): ${unmapped.join("; ")}`,
      );
    return { ...schedule, bundled: false, fetchedAt: now() };
  }

  function startRefresh(): Promise<Cached> {
    inflight ??= refresh()
      .then(
        (schedule) => {
          cached = schedule;
          lastFailureAt = null;
          return schedule;
        },
        (error: unknown) => {
          lastFailureAt = now();
          throw error;
        },
      )
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  function bundledCopy(): Cached {
    fallback ??= { ...fromCsv(bundled.csv, bundled.season, targets), bundled: true, fetchedAt: -Infinity };
    return fallback;
  }

  const strip = ({ fetchedAt: _, ...schedule }: Cached): ListedSchedule => schedule;

  return async function get(): Promise<ListedSchedule> {
    const t = now();
    if (cached && t - cached.fetchedAt < TTL_MS && cached.season === seasonFor(t)) return strip(cached);
    const backingOff = lastFailureAt !== null && t - lastFailureAt < RETRY_AFTER_MS;
    if (cached) {
      if (!backingOff)
        defer(startRefresh().catch((error: unknown) => console.warn("stations.schedule: refresh failed:", error)));
      return strip(cached);
    }
    if (!backingOff) {
      try {
        return strip(await startRefresh());
      } catch (error) {
        console.warn("stations.schedule: serving the bundled copy:", error);
      }
    }
    return strip(bundledCopy());
  };
}

/** The one cached schedule for this server: `stations.schedule` serves it, and `reports.submit` checks against it. */
export const getSchedule = scheduleSource();

/** What the page gets: the schedule without the server-only listing (#72 eng review, D7). */
export function forPageSchedule({ listed: _, ...schedule }: ListedSchedule): Schedule {
  return schedule;
}

type SiteOptions = Pick<Options, "fetchImpl" | "now" | "defer"> & {
  /** The fallback table, the one bundled in eibi-snapshot.json. */
  bundled?: () => SiteTable;
};

/**
 * EiBi's transmitter-site table (lib/eibi-sites.ts), for reports.submit only:
 * it answers at once from what it has, the bundled table until a fetch
 * succeeds, and refreshes README.TXT in the background at most once a day,
 * so no answer and no page load waits on eibispace.de (#72 eng review, D9).
 * A failed or broken fetch keeps the last good table and asks again in ten
 * minutes (D6, D11). A new table is checked against the largest one this
 * server has accepted, the bundled one included, so a run of slightly short
 * READMEs can't step the bar down one refresh at a time (#72 follow-up, D6).
 */
export function siteSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  defer = after,
  bundled = () => sitesFromJson(snapshot.sites),
}: SiteOptions = {}) {
  let table: SiteTable | null = null;
  /** The largest table accepted so far: the bar a new one must clear. */
  let best: SiteTable | null = null;
  let fetchedAt = -Infinity;
  let lastFailureAt: number | null = null;
  let inflight: Promise<void> | null = null;

  async function refresh(): Promise<SiteTable> {
    return parseSites(await fetchLatin1(fetchImpl, SITES_URL, "EiBi README"), best ?? undefined);
  }

  return function get(): SiteTable {
    table ??= bundled();
    best ??= table;
    const t = now();
    const backingOff = lastFailureAt !== null && t - lastFailureAt < RETRY_AFTER_MS;
    if (!inflight && !backingOff && t - fetchedAt >= TTL_MS) {
      inflight = refresh()
        .then(
          (fresh) => {
            table = fresh;
            if (fresh.size > best!.size) best = fresh;
            fetchedAt = now();
            lastFailureAt = null;
          },
          (error: unknown) => {
            lastFailureAt = now();
            console.warn("stations.sites: refresh failed, keeping the last good table:", error);
          },
        )
        .finally(() => {
          inflight = null;
        });
      defer(inflight);
    }
    return table;
  };
}

/** The one site table for this server, read by `reports.submit`. */
export const getSites = siteSource();

export const stationsRouter = router({
  schedule: publicProcedure.query(async () => forPageSchedule(await getSchedule())),
});
