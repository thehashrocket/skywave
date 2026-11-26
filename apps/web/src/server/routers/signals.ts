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
import { COUNT_MS, HEARD_SHOWN_MS, lastHeard, sharedChannels, type LastHeard } from "@/lib/signal-heard";
import { ON_KHZ } from "@/lib/signal-panel";
import { SIGNAL_STATIONS } from "@/lib/signal-stations";
import type { db as Db } from "../db";
import { readCapped } from "../read-capped";
import { publicProcedure, router } from "../trpc";

// Priyom's frequencies change monthly and its schedules weekly; a few hours is plenty.
const TTL_MS = 6 * 60 * 60_000;
// After a failed fetch, serve what we have and ask again in ten minutes.
const RETRY_AFTER_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
// A day's slice is about 20 KB.
const MAX_BYTES = 1_000_000;

/**
 * The catalog's Priyom designators, each to the station's main one (F06a to F06,
 * priyomAlso): only their transmissions go to the page, filed under the main one.
 */
const CATALOG_IDS = new Map(
  SIGNAL_STATIONS.flatMap((s) => (s.priyom ? [s.priyom, ...(s.priyomAlso ?? [])].map((id) => [id, s.priyom!] as const) : [])),
);

/**
 * The catalog stations' transmissions, each under its station's main designator;
 * one Priyom listed under another designator keeps it (`designator`), so an
 * answer about it can say which (owner, #148).
 */
export function catalogTransmissions(txs: readonly PriyomTx[]): PriyomTx[] {
  return txs.flatMap((tx) => {
    const main = CATALOG_IDS.get(tx.station);
    if (main === undefined) return [];
    return [main === tx.station ? tx : { ...tx, station: main, designator: tx.station }];
  });
}

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
    const transmissions = catalogTransmissions(mergeSlices(slices));
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

/**
 * How long the server keeps a lastHeard answer before reading the reports
 * again (#102). Ten minutes, not one (owner decision on the #102 review): the
 * database (Neon) only sleeps after five idle minutes, so reading every minute
 * while anyone has the page open would keep it awake and billing; a "heard"
 * can take up to ~20 minutes (this plus the page's poll) to show instead.
 */
export const LAST_HEARD_TTL_MS = 10 * 60_000;

/**
 * How long a lastHeard read may take (#102 review). A hung read (a database
 * resuming, a half-open socket) would otherwise pin the shared in-flight read
 * for the instance's life; past this it counts as a failed read, so the last
 * answer is served and the backoff applies.
 */
export const LAST_HEARD_READ_TIMEOUT_MS = 8_000;

/** The channels signal stations share (WWV and WWVH), from the catalog: fixed, so worked out once. */
const SHARED_CHANNELS = sharedChannels();

export type LastHeardAnswer = { heard: Record<string, LastHeard>; at: number };

/**
 * The "last heard" badges' data (#102): signal-station answers summed per
 * station by the database (each station's newest "heard" of the last
 * HEARD_SHOWN_MS, overall and on each channel stations share, and the last
 * COUNT_MS's answers by outcome), so a read returns a few rows per station
 * however many answers there are, and a flood of answers about one station
 * can't push another's newest "heard" out of it (#102 review). Turned into
 * badges by lib/signal-heard.ts, read at most once a LAST_HEARD_TTL_MS per
 * server instance and shared between concurrent callers. When
 * a read fails (or takes over LAST_HEARD_READ_TIMEOUT_MS), the next read waits
 * a LAST_HEARD_TTL_MS, so a struggling database isn't asked on every poll;
 * meanwhile the last good answer is served, or, with none yet, the error goes
 * to the page, which shows no badges.
 */
export function lastHeardSource({ now = () => Date.now() }: { now?: () => number } = {}) {
  let cached: LastHeardAnswer | null = null;
  let inflight: Promise<LastHeardAnswer> | null = null;
  let lastFailureAt: number | null = null;
  let lastError: unknown = null;

  async function read(db: typeof Db): Promise<LastHeardAnswer> {
    const at = now();
    const until = new Date(at);
    const heard = { txKind: "signal", outcome: "heard", createdAt: { gte: new Date(at - HEARD_SHOWN_MS), lte: until } };
    const newestBy = (where: typeof heard & { freqKhz?: { gte: number; lte: number } }) =>
      db.receptionReport.groupBy({ by: ["txName"], where, _max: { createdAt: true } });
    const [latest, shared, counts] = await Promise.all([
      newestBy(heard),
      Promise.all(
        SHARED_CHANNELS.map(async ({ khz }) =>
          (await newestBy({ ...heard, freqKhz: { gte: khz - ON_KHZ, lte: khz + ON_KHZ } })).map((r) => ({ khz, ...r })),
        ),
      ),
      db.receptionReport.groupBy({
        by: ["txName", "outcome"],
        where: { txKind: "signal", createdAt: { gte: new Date(at - COUNT_MS), lte: until } },
        _count: { _all: true },
      }),
    ]);
    const ms = (r: { _max: { createdAt: Date | null } }) => r._max.createdAt?.getTime() ?? null;
    const sums = {
      latest: latest.flatMap((r) => (ms(r) === null ? [] : [{ txName: r.txName, ms: ms(r)! }])),
      shared: shared.flat().flatMap((r) => (ms(r) === null ? [] : [{ khz: r.khz, txName: r.txName, ms: ms(r)! }])),
      counts: counts.map((r) => ({ txName: r.txName, outcome: r.outcome, n: r._count._all })),
    };
    return { heard: lastHeard(sums, at), at };
  }

  return async function get(db: typeof Db): Promise<LastHeardAnswer> {
    const t = now();
    if (cached && t - cached.at < LAST_HEARD_TTL_MS) return cached;
    // Backing off after a failed read, with or without an answer to serve (#102 review):
    // a fresh instance facing a sleeping or failing database mustn't read on every request.
    if (lastFailureAt !== null && t - lastFailureAt < LAST_HEARD_TTL_MS) {
      if (cached) return cached;
      throw lastError;
    }
    inflight ??= withTimeout(read(db), LAST_HEARD_READ_TIMEOUT_MS)
      .then(
        (fresh) => {
          lastFailureAt = null;
          return (cached = fresh);
        },
        (error: unknown) => {
          lastFailureAt = now();
          lastError = error;
          throw error;
        },
      )
      .finally(() => {
        inflight = null;
      });
    try {
      return await inflight;
    } catch (error) {
      if (!cached) throw error;
      console.warn("signals.lastHeard: read failed, serving the last answer:", error);
      return cached;
    }
  };
}

/** `p`, or a rejection once `ms` pass without it settling. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`signals.lastHeard: read took over ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The one cached lastHeard answer for this server instance. */
export const getLastHeard = lastHeardSource();

export const signalsRouter = router({
  priyom: publicProcedure.query(() => getPriyomSchedule()),
  lastHeard: publicProcedure.query(({ ctx }) => getLastHeard(ctx.db)),
});
