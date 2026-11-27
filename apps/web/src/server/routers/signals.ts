import { after } from "next/server";
import {
  changesBetween,
  describeChanges,
  mergeSlices,
  nextFeedRecord,
  parsePriyomEvents,
  priyomSliceUrls,
  type PriyomCopy,
  type PriyomFeedRecord,
  type PriyomTx,
} from "@/lib/priyom-schedule";
import { dayNightRows } from "@/lib/on-air";
import { COUNT_MS, HEARD_SHOWN_MS, lastHeard, sharedChannels, type LastHeard } from "@/lib/signal-heard";
import { ON_KHZ } from "@/lib/signal-panel";
import { SIGNAL_STATIONS } from "@/lib/signal-stations";
import type { db as Db } from "../db";
import { groupedTallies } from "../grouped-tallies";
import { readCapped } from "../read-capped";
import { getSchedule } from "./stations";
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
  /** Saves each good fetch where every instance can see it (#147), after the response; a failure is only logged. */
  record?: (copy: PriyomSchedule) => Promise<void>;
};

/** This instance's view of the feed, for the freshness report (#147). */
export type PriyomFetchStatus = {
  /** When the copy being served was fetched, or null with none. */
  fetchedAt: number | null;
  /** Why the last fetch failed, while no fetch has succeeded since; null otherwise. */
  error: string | null;
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
export function priyomScheduleSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  defer = after,
  record,
}: Options = {}) {
  let cached: PriyomSchedule | null = null;
  let inflight: Promise<PriyomSchedule> | null = null;
  let lastFailureAt: number | null = null;
  let lastError: string | null = null;
  /** The last good fetch's save, so refreshNow can wait for it. */
  let lastSave: Promise<void> = Promise.resolve();

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
    const changes = changesBetween(prev, next);
    if (changes.length) console.info("signals.priyom: schedule changed:", describeChanges(changes));
  }

  /** Records a good fetch after the response (record); outside a request, `after` throws, so it just runs. */
  function saveCopy(fresh: PriyomSchedule) {
    if (!record) return;
    const task = record(fresh).catch((error: unknown) => console.warn("signals.priyom: not recorded:", error));
    lastSave = task;
    try {
      defer(task);
    } catch {
      // Not in a request: the task is already running.
    }
  }

  function startRefresh(): Promise<PriyomSchedule> {
    inflight ??= refresh()
      .then(
        (fresh) => {
          if (cached) logChanges(cached, fresh);
          cached = fresh;
          lastFailureAt = null;
          lastError = null;
          saveCopy(fresh);
          return fresh;
        },
        (error: unknown) => {
          lastFailureAt = now();
          lastError = error instanceof Error ? error.message : String(error);
          throw error;
        },
      )
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  const status = (): PriyomFetchStatus => ({ fetchedAt: cached?.fetchedAt ?? null, error: lastError });

  async function get(): Promise<PriyomSchedule | null> {
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
  }

  /**
   * The freshness report's read (#147 review, owner D2): fetches now, whatever the cache's
   * age, and waits for the copy to be saved, so the report judges the feed rather than how
   * long ago a visitor last caused a fetch. A failed fetch leaves the last copy (or null) and
   * its error in status(); a failed save is logged and shows as a stale shared record.
   */
  async function refreshNow(): Promise<PriyomSchedule | null> {
    try {
      await startRefresh();
    } catch (error) {
      console.warn("signals.priyom: refresh for the freshness report failed:", error);
    }
    await lastSave;
    return cached;
  }

  return Object.assign(get, { status, refreshNow });
}

/** The one row PriyomFeed holds. */
const FEED_ID = "priyom";

/** The record of Priyom's feed every instance shares (#147), or null before the first good fetch anywhere. */
export async function readPriyomFeed(db: typeof Db): Promise<PriyomFeedRecord | null> {
  const row = await db.priyomFeed.findUnique({ where: { id: FEED_ID } });
  if (!row) return null;
  return {
    transmissions: row.transmissions as unknown as PriyomTx[],
    fetchedAt: row.fetchedAt.getTime(),
    trackedSince: row.trackedSince.getTime(),
    changedAt: row.changedAt?.getTime() ?? null,
  };
}

/**
 * Saves a good fetch to the shared record (nextFeedRecord): the last copy, and
 * when Priyom last changed a catalog station's slots. Read, compare, write: two
 * instances saving at once can lose one comparison, which at worst moves a
 * change to the next fetch, hours later.
 */
export async function recordPriyomFetch(db: typeof Db, copy: PriyomCopy): Promise<void> {
  const prev = await readPriyomFeed(db);
  const next = nextFeedRecord(prev, copy);
  if (next === prev) return;
  const data = {
    transmissions: next.transmissions as unknown as object,
    fetchedAt: new Date(next.fetchedAt),
    trackedSince: new Date(next.trackedSince),
    changedAt: next.changedAt === null ? null : new Date(next.changedAt),
  };
  await db.priyomFeed.upsert({ where: { id: FEED_ID }, create: { id: FEED_ID, ...data }, update: data });
}

/** The one cached Priyom schedule for this server; each good fetch is recorded in the database (#147). */
export const getPriyomSchedule = priyomScheduleSource({
  record: async (copy) => recordPriyomFetch((await import("../db")).db, copy),
});

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
    const newestBy = (where: typeof heard & { freqKhz?: { gte: number; lte: number }; askGroup?: null }) =>
      db.receptionReport.groupBy({ by: ["txName"], where, _max: { createdAt: true } });
    const countFrom = new Date(at - COUNT_MS);
    const [latest, shared, counts, grouped] = await Promise.all([
      newestBy(heard),
      // Only single-station answers make a shared channel's "WWV or WWVH heard": a
      // shared-frequency answer (#150) names the one heard, and counts as its alone.
      Promise.all(
        SHARED_CHANNELS.map(async ({ khz }) =>
          (await newestBy({ ...heard, askGroup: null, freqKhz: { gte: khz - ON_KHZ, lte: khz + ON_KHZ } })).map((r) => ({
            khz,
            ...r,
          })),
        ),
      ),
      db.receptionReport.groupBy({
        by: ["txName", "outcome"],
        where: { txKind: "signal", askGroup: null, createdAt: { gte: countFrom, lte: until } },
        _count: { _all: true },
      }),
      // Shared-frequency answers (#150): a station not heard beside one that was comes back as
      // NOT_HEARD_OVER_OTHER, which lastHeard doesn't count as "not heard" (owner, #150).
      groupedTallies(db, countFrom, until, false),
    ]);
    const ms = (r: { _max: { createdAt: Date | null } }) => r._max.createdAt?.getTime() ?? null;
    const sums = {
      latest: latest.flatMap((r) => (ms(r) === null ? [] : [{ txName: r.txName, ms: ms(r)! }])),
      shared: shared.flat().flatMap((r) => (ms(r) === null ? [] : [{ khz: r.khz, txName: r.txName, ms: ms(r)! }])),
      counts: [
        ...counts.map((r) => ({ txName: r.txName, outcome: r.outcome, n: r._count._all })),
        ...grouped.map((r) => ({ txName: r.txName, outcome: r.outcome, n: r.n })),
      ],
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
  /** The day/night stations' EiBi rows from the server's copy, for a station page (#168). */
  dayNight: publicProcedure.query(async () => dayNightRows((await getSchedule()).broadcasts)),
});
