import { after } from "next/server";
import { IBP_FOOTNOTES_URL, IBP_STATUS_URL, parseFootnotes, parseIbpStatus, type IbpStatus } from "@/lib/ibp-status";
import { countBeaconSpots, dayBefore, RBN_DAY_URL, rbnDayFor, type RbnDay } from "@/lib/rbn";
import { readCapped } from "../read-capped";
import { unzipFile } from "../unzip";
import { publicProcedure, router } from "../trpc";

// NCDXF checks the list daily; every few hours is plenty.
const TTL_MS = 3 * 60 * 60_000;
// After a failed fetch, serve what we have and ask again in ten minutes.
const RETRY_AFTER_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
// Each real file is well under 1 KB.
const MAX_BYTES = 64_000;

type Cached = { status: IbpStatus; fetchedAt: number };

type Options = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Keeps a background refresh running after the response is sent. */
  defer?: (task: Promise<unknown>) => void;
};

/**
 * NCDXF's official beacon status (issue #69), fetched at most every few hours
 * and shared between concurrent callers, like `scheduleSource`. It never
 * fails: on a failed fetch it keeps serving the last good copy, and until one
 * succeeds it serves null (status unknown: every beacon is treated as on the
 * air). No copy is bundled, since an old one would mark beacons wrongly. Only
 * the first request on a fresh server waits for ncdxf.org.
 *
 * The footnotes only add text: if their file fails while the status file
 * loads, the last good notes are kept (or none).
 */
export function beaconStatusSource({ fetchImpl = (...args) => fetch(...args), now = () => Date.now(), defer = after }: Options = {}) {
  let cached: Cached | null = null;
  let notes: Map<string, string> = new Map();
  let inflight: Promise<Cached> | null = null;
  let lastFailureAt: number | null = null;

  async function text(url: string, what: string): Promise<string> {
    const res = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "skywave (+https://github.com/thehashrocket/skywave)" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${what} request failed: HTTP ${res.status}`);
    return (await readCapped(res, MAX_BYTES, what)).toString("utf8");
  }

  async function refresh(): Promise<Cached> {
    const [status, footnotes] = await Promise.allSettled([
      text(IBP_STATUS_URL, "The IBP status file"),
      text(IBP_FOOTNOTES_URL, "The IBP footnotes file"),
    ]);
    if (status.status === "rejected") throw status.reason;
    // A footnotes file with no readable note (an error page) keeps the last good notes too.
    const fresh = footnotes.status === "fulfilled" ? parseFootnotes(footnotes.value) : null;
    if (fresh?.size) notes = fresh;
    else console.warn("beacons.status: keeping the last footnotes:", footnotes.status === "rejected" ? footnotes.reason : "no notes in the file");
    return { status: parseIbpStatus(status.value, notes), fetchedAt: now() };
  }

  function startRefresh(): Promise<Cached> {
    inflight ??= refresh()
      .then(
        (fresh) => {
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

  return async function get(): Promise<IbpStatus | null> {
    const t = now();
    if (cached && t - cached.fetchedAt < TTL_MS) return cached.status;
    const backingOff = lastFailureAt !== null && t - lastFailureAt < RETRY_AFTER_MS;
    if (cached) {
      if (!backingOff)
        defer(startRefresh().catch((error: unknown) => console.warn("beacons.status: refresh failed:", error)));
      return cached.status;
    }
    if (backingOff) return null;
    try {
      return (await startRefresh()).status;
    } catch (error) {
      console.warn("beacons.status: no status yet:", error);
      return null;
    }
  };
}

/** The one cached status for this server: `beacons.status` serves it, and `reports.submit` records it. */
export const getBeaconStatus = beaconStatusSource();

// RBN's daily zip is about 6 MB (41 MB of CSV); leave room to grow.
const RBN_MAX_ZIP_BYTES = 40_000_000;
const RBN_MAX_CSV_BYTES = 300_000_000;
const RBN_TIMEOUT_MS = 60_000;

/** Where the counted days are kept: the database, so one server's download serves them all. */
export type RbnStore = {
  load: (day: string) => Promise<RbnDay | null>;
  save: (day: RbnDay) => Promise<void>;
};

const dbStore: RbnStore = {
  async load(day) {
    const { db } = await import("../db");
    const row = await db.rbnBeaconDay.findUnique({ where: { day } });
    return row ? { day: row.day, total: row.total, beacons: row.beacons as RbnDay["beacons"] } : null;
  },
  async save(d) {
    const { db } = await import("../db");
    // Two servers can count the same day at once; the second write changes nothing.
    await db.rbnBeaconDay.upsert({
      where: { day: d.day },
      create: { day: d.day, total: d.total, beacons: d.beacons },
      update: {},
    });
  },
};

type RbnOptions = Omit<Options, "now"> & { now?: () => number; store?: RbnStore };

/**
 * RBN's IBP spot counts for the last whole UTC day (issue #69 v2). The day's
 * file is downloaded once, after 01:00 UTC, by whichever server first asks,
 * and counted and saved in the database; every server reads the saved day.
 * No request waits on the download: until the day is saved, `get` serves the
 * day before (or null) and downloads in the background (backing off ten
 * minutes after a failure). `peek` never downloads, for `reports.submit`.
 * Anything older than the day before is too stale to show: null.
 */
export function rbnSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  defer = after,
  store = dbStore,
}: RbnOptions = {}) {
  const memory = new Map<string, RbnDay>();
  let inflight: Promise<void> | null = null;
  let lastFailureAt: number | null = null;

  async function load(day: string): Promise<RbnDay | null> {
    const kept = memory.get(day);
    if (kept) return kept;
    try {
      const found = await store.load(day);
      if (found) memory.set(day, found);
      return found;
    } catch (error) {
      console.warn("beacons.rbn: couldn't read the saved day:", error);
      return null;
    }
  }

  async function download(day: string): Promise<void> {
    const res = await fetchImpl(RBN_DAY_URL(day), {
      redirect: "error",
      signal: AbortSignal.timeout(RBN_TIMEOUT_MS),
      headers: { "user-agent": "skywave (+https://github.com/thehashrocket/skywave)" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`RBN's file for ${day}: HTTP ${res.status}`);
    const zip = await readCapped(res, RBN_MAX_ZIP_BYTES, `RBN's file for ${day}`);
    const counted = countBeaconSpots(unzipFile(zip, ".csv", RBN_MAX_CSV_BYTES).toString("utf8"), day);
    memory.set(day, counted);
    await store.save(counted);
  }

  function startDownload(day: string) {
    if (inflight || (lastFailureAt !== null && now() - lastFailureAt < RETRY_AFTER_MS)) return;
    inflight = download(day)
      .then(
        () => {
          lastFailureAt = null;
        },
        (error: unknown) => {
          lastFailureAt = now();
          console.warn("beacons.rbn: download failed:", error);
        },
      )
      .finally(() => {
        inflight = null;
      });
    defer(inflight);
  }

  /** The target day if saved, else the day before (or null); downloads the target day in the background if `fetch`. */
  async function read(fetch: boolean): Promise<RbnDay | null> {
    const day = rbnDayFor(now());
    const found = await load(day);
    if (found) return found;
    if (fetch) startDownload(day);
    return load(dayBefore(day));
  }

  return { get: () => read(true), peek: () => read(false) };
}

/** The one RBN source for this server: `beacons.rbn` serves it, and `reports.submit` records it. */
export const rbnDays = rbnSource();

export const beaconsRouter = router({
  status: publicProcedure.query(() => getBeaconStatus()),
  rbn: publicProcedure.query(() => rbnDays.get()),
});
