import { after } from "next/server";
import {
  describeChanges,
  diffSchedules,
  mergeSlices,
  parsePriyomEvents,
  priyomSliceUrls,
  priyomSpan,
  type PriyomTx,
} from "@/lib/priyom-schedule";
import { SIGNAL_STATIONS } from "@/lib/signal-stations";
import { readCapped } from "../read-capped";
import { publicProcedure, router } from "../trpc";

// Priyom's frequencies change monthly and its schedules weekly; a few hours is plenty.
const TTL_MS = 6 * 60 * 60_000;
// After a failed fetch, serve what we have and ask again in ten minutes.
const RETRY_AFTER_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
// A day's slice is about 20 KB.
const MAX_BYTES = 1_000_000;

/** The catalog's Priyom designators: only their transmissions go to the page. */
const CATALOG_IDS = new Set(SIGNAL_STATIONS.flatMap((s) => (s.priyom ? [s.priyom] : [])));

export type PriyomSchedule = { transmissions: PriyomTx[]; fetchedAt: number };

type Options = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Keeps a background refresh running after the response is sent. */
  defer?: (task: Promise<unknown>) => void;
};

/**
 * Priyom's schedule (#98), for the catalog's numbers stations: PRIYOM_SLICES
 * day-long slices from 12 hours before the last 00:00/12:00 UTC boundary to a
 * week ahead (priyomSpan), fetched together at most every few hours, shared
 * between concurrent callers, like `beaconStatusSource`. The panel reads it, and
 * reports.submit checks numbers-station answers against it (#101), so on a
 * server with no copy yet an answer can be what starts the first fetch. It never fails:
 * a failed refresh keeps the last good copy, and until one succeeds it serves
 * null (schedule unknown: the stations stay listed without times). No copy is
 * bundled, since an old one would send Listen to last month's frequencies.
 * Every slice must load: a week with a missing day would show wrong "up next" times.
 */
export function priyomScheduleSource({ fetchImpl = (...args) => fetch(...args), now = () => Date.now(), defer = after }: Options = {}) {
  let cached: PriyomSchedule | null = null;
  let inflight: Promise<PriyomSchedule> | null = null;
  let lastFailureAt: number | null = null;

  async function slice(url: string): Promise<PriyomTx[]> {
    const res = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "skywave (+https://github.com/thehashrocket/skywave)" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Priyom schedule request failed: HTTP ${res.status}`);
    const body = (await readCapped(res, MAX_BYTES, "Priyom's schedule")).toString("utf8");
    return parsePriyomEvents(JSON.parse(body));
  }

  async function refresh(): Promise<PriyomSchedule> {
    const t = now();
    const slices = await Promise.all(priyomSliceUrls(t).map(slice));
    const transmissions = mergeSlices(slices).filter((tx) => CATALOG_IDS.has(tx.station));
    return { transmissions, fetchedAt: t };
  }

  /**
   * Logs which stations' slots changed since the last fetch (frequency, mode,
   * or a slot added or dropped), over the time both fetches cover: Priyom's
   * feed has no change marker of its own, so this is how a monthly frequency
   * change, or how often Priyom edits, shows up.
   */
  function logChanges(prev: PriyomSchedule, next: PriyomSchedule) {
    const a = priyomSpan(prev.fetchedAt);
    const b = priyomSpan(next.fetchedAt);
    const changes = diffSchedules(prev.transmissions, next.transmissions, {
      fromMs: Math.max(a.fromMs, b.fromMs, next.fetchedAt),
      toMs: Math.min(a.toMs, b.toMs),
    });
    if (changes.length) console.info("signals.priyom: schedule changed:", describeChanges(changes));
  }

  function startRefresh(): Promise<PriyomSchedule> {
    inflight ??= refresh()
      .then(
        (fresh) => {
          if (cached) logChanges(cached, fresh);
          cached = fresh;
          lastFailureAt = null;
          return fresh;
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

  return async function get(): Promise<PriyomSchedule | null> {
    const t = now();
    if (cached && t - cached.fetchedAt < TTL_MS) return cached;
    const backingOff = lastFailureAt !== null && t - lastFailureAt < RETRY_AFTER_MS;
    if (cached) {
      if (!backingOff)
        defer(startRefresh().catch((error: unknown) => console.warn("signals.priyom: refresh failed:", error)));
      return cached;
    }
    if (backingOff) return null;
    try {
      return await startRefresh();
    } catch (error) {
      console.warn("signals.priyom: no schedule yet:", error);
      return null;
    }
  };
}

/** The one cached Priyom schedule for this server. */
export const getPriyomSchedule = priyomScheduleSource();

export const signalsRouter = router({
  priyom: publicProcedure.query(() => getPriyomSchedule()),
});
