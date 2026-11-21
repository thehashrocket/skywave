import { after } from "next/server";
import { IBP_FOOTNOTES_URL, IBP_STATUS_URL, parseFootnotes, parseIbpStatus, type IbpStatus } from "@/lib/ibp-status";
import { gzipSync } from "node:zlib";
import {
  countBeaconSpots,
  dayBefore,
  parseSkimmerList,
  RBN_DAY_URL,
  RBN_SKIMMERS_URL,
  rbnDayFor,
  utcDay,
  type RbnDay,
  type Skimmer,
} from "@/lib/rbn";
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

// The list page is about 310 KB (2026-11-19); leave room to grow.
const SKIMMERS_MAX_BYTES = 2_000_000;
const SKIMMERS_TIMEOUT_MS = 30_000;

/** One UTC day's saved skimmer list, with the page it came from (gzipped). */
export type SkimmerDay = { day: string; fetchedAt: number; skimmers: Skimmer[]; raw: Uint8Array<ArrayBuffer> };

/** A page RBN served that wasn't saved as a day, kept so the day can be parsed again later. */
export type SkimmerRefusal = {
  day: string;
  fetchedAt: number;
  reason: string;
  /** How many skimmers it parsed to; null when it didn't parse. */
  total: number | null;
  raw: Uint8Array<ArrayBuffer>;
};

/** Where the skimmer lists are kept: one row per UTC day, plus each refused page (up to SKIMMERS_MAX_REFUSALS a day). */
export type SkimmerStore = {
  has: (day: string) => Promise<boolean>;
  /** The most recently saved day's skimmer count, or null before the first. */
  lastTotal: () => Promise<number | null>;
  /** Saves a day; throws Prisma's P2002 if another run saved it first. */
  save: (day: SkimmerDay) => Promise<void>;
  /** Keeps a page; each run's page is kept, so a later refusal never replaces an earlier one. */
  refuse: (refusal: SkimmerRefusal) => Promise<void>;
  /** How many pages are kept for a day. */
  refusals: (day: string) => Promise<number>;
  /** The skimmer count of a day's latest page refused by the 80% rule, or null. */
  lastShortTotal: (day: string) => Promise<number | null>;
};

/**
 * At most this many refused pages are kept per day. The cron runs twice a day,
 * so this leaves room for runs by hand while keeping a caller that holds
 * CRON_SECRET from filling the table.
 */
export const SKIMMERS_MAX_REFUSALS = 10;

/**
 * A new list must keep at least this share of the last saved day's skimmers:
 * RBN's list moves by a few a day, while a page cut off partway loses far
 * more (the same rule as EiBi's site table, lib/eibi-sites.ts).
 */
export const SKIMMERS_MIN_SHARE = 0.8;

/**
 * A real drop (RBN's 7-day list shrinking after a contest weekend, say) is
 * refused like a cut-off page, but it repeats: a list under the bar is taken
 * when the day before was refused by the same rule with a count within this
 * share of it. Otherwise one lasting drop would refuse every day after it,
 * since a refused day never moves the bar.
 */
export const SKIMMERS_AGREE_SHARE = 0.1;

// Every 80%-rule refusal starts with this, so the next day can find it.
const SHORT_REASON = "RBN skimmer list refused: under ";

const skimmerDbStore: SkimmerStore = {
  async has(day) {
    const { db } = await import("../db");
    return (await db.rbnSkimmerDay.findUnique({ where: { day }, select: { day: true } })) !== null;
  },
  async lastTotal() {
    const { db } = await import("../db");
    const last = await db.rbnSkimmerDay.findFirst({ orderBy: { day: "desc" }, select: { total: true } });
    return last?.total ?? null;
  },
  async refuse(r) {
    const { db } = await import("../db");
    await db.rbnSkimmerRefusal.create({
      data: { day: r.day, fetchedAt: new Date(r.fetchedAt), reason: r.reason, total: r.total, raw: r.raw },
    });
  },
  async refusals(day) {
    const { db } = await import("../db");
    return db.rbnSkimmerRefusal.count({ where: { day } });
  },
  async lastShortTotal(day) {
    const { db } = await import("../db");
    const row = await db.rbnSkimmerRefusal.findFirst({
      where: { day, reason: { startsWith: SHORT_REASON } },
      orderBy: { fetchedAt: "desc" },
      select: { total: true },
    });
    return row?.total ?? null;
  },
  async save(d) {
    const { db } = await import("../db");
    // The second run of the day, or two at once: the first write stands.
    await db.rbnSkimmerDay.upsert({
      where: { day: d.day },
      create: {
        day: d.day,
        fetchedAt: new Date(d.fetchedAt),
        total: d.skimmers.length,
        skimmers: d.skimmers,
        raw: d.raw,
      },
      update: {},
    });
  },
};

/**
 * Saves today's (UTC) RBN skimmer list once (#61, D14), for the Vercel cron
 * that calls it twice a day: the second call finds the day saved and fetches
 * nothing, or saves it when the first failed. A page that doesn't parse as the
 * list, or holds under SKIMMERS_MIN_SHARE of the last saved day's skimmers (a
 * page cut off partway) unless the day before was refused for an agreeing
 * count (a real drop), isn't saved as the day: it's kept as a refusal so it
 * can be parsed again later, and the day stays open for the next run.
 */
export async function saveSkimmerDay({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  store = skimmerDbStore,
}: { fetchImpl?: typeof fetch; now?: () => number; store?: SkimmerStore } = {}): Promise<
  { status: "kept"; day: string } | { status: "saved"; day: string; total: number }
> {
  const day = utcDay(now());
  if (await store.has(day)) return { status: "kept", day };
  const res = await fetchImpl(RBN_SKIMMERS_URL, {
    redirect: "error",
    signal: AbortSignal.timeout(SKIMMERS_TIMEOUT_MS),
    headers: { "user-agent": "skywave (+https://github.com/thehashrocket/skywave)" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RBN's skimmer list: HTTP ${res.status}`);
  const page = await readCapped(res, SKIMMERS_MAX_BYTES, "RBN's skimmer list");
  const fetchedAt = now();
  const raw = gzipSync(page);
  // Read before parsing: a database error here is an outage, not a page refusal.
  const last = await store.lastTotal();
  // The day before's 80%-rule refusal counts only while that day stayed unsaved:
  // once a later run saved it, its list is the bar, and a short list today is a cut.
  const prev = dayBefore(day);
  const before = last === null || (await store.has(prev)) ? null : await store.lastShortTotal(prev);
  let skimmers: Skimmer[] | null = null;
  const keep = async (reason: string) => {
    try {
      if ((await store.refusals(day)) >= SKIMMERS_MAX_REFUSALS) {
        console.warn(`cron.rbn-skimmers: ${SKIMMERS_MAX_REFUSALS} pages already kept for ${day}; not keeping this one.`);
        return;
      }
      await store.refuse({ day, fetchedAt, reason, total: skimmers?.length ?? null, raw });
    } catch (keepError) {
      console.warn("cron.rbn-skimmers: couldn't keep the page:", keepError);
    }
  };
  try {
    skimmers = parseSkimmerList(page.toString("utf8"), fetchedAt);
    const n = skimmers.length;
    if (last !== null && n < last * SKIMMERS_MIN_SHARE) {
      const agrees = before !== null && Math.abs(before - n) <= n * SKIMMERS_AGREE_SHARE;
      if (!agrees)
        throw new Error(
          `${SHORT_REASON}${SKIMMERS_MIN_SHARE * 100}% of the last saved day's ${last} skimmers (${n}).`,
        );
    }
  } catch (error) {
    await keep(error instanceof Error ? error.message : String(error));
    throw error;
  }
  try {
    await store.save({ day, fetchedAt, skimmers, raw });
  } catch (error) {
    // Two runs at once, and the other saved the day first: its write stands.
    if ((error as { code?: unknown } | null)?.code === "P2002") return { status: "kept", day };
    // A good page whose save failed is still worth keeping, if the database takes it.
    await keep(`Not saved: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  return { status: "saved", day, total: skimmers.length };
}

/** The one RBN source for this server: `beacons.rbn` serves it, and `reports.submit` records it. */
export const rbnDays = rbnSource();

export const beaconsRouter = router({
  status: publicProcedure.query(() => getBeaconStatus()),
  rbn: publicProcedure.query(() => rbnDays.get()),
});
