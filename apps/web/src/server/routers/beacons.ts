import { after } from "next/server";
import { IBP_FOOTNOTES_URL, IBP_STATUS_URL, parseFootnotes, parseIbpStatus, type IbpStatus } from "@/lib/ibp-status";
import { readCapped } from "../read-capped";
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

export const beaconsRouter = router({
  status: publicProcedure.query(() => getBeaconStatus()),
});
