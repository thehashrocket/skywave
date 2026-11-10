import { after } from "next/server";
import { parseEibi, scheduleUrl, seasonFor, type Broadcast } from "@/lib/eibi";
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
};

type Cached = Schedule & { fetchedAt: number };

type Options = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Keeps a background refresh running after the response is sent. */
  defer?: (task: Promise<unknown>) => void;
  /** The fallback copy: the season it's for and the file's text. */
  bundled?: { season: string; csv: string };
};

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
}: Options = {}) {
  let cached: Cached | null = null;
  let fallback: Cached | null = null;
  let inflight: Promise<Cached> | null = null;
  let lastFailureAt: number | null = null;

  async function refresh(): Promise<Cached> {
    const season = seasonFor(now());
    const res = await fetchImpl(scheduleUrl(season), {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "skywave (+https://github.com/thehashrocket/skywave)" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`EiBi schedule request failed: HTTP ${res.status}`);
    // The file is Latin-1.
    const csv = (await readCapped(res, MAX_BYTES, "The EiBi schedule")).toString("latin1");
    return { season, broadcasts: parseEibi(csv, season), bundled: false, fetchedAt: now() };
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
    fallback ??= {
      season: bundled.season,
      broadcasts: parseEibi(bundled.csv, bundled.season),
      bundled: true,
      fetchedAt: -Infinity,
    };
    return fallback;
  }

  const strip = ({ fetchedAt: _, ...schedule }: Cached): Schedule => schedule;

  return async function get(): Promise<Schedule> {
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

const getSchedule = scheduleSource();

export const stationsRouter = router({
  schedule: publicProcedure.query(() => getSchedule()),
});
