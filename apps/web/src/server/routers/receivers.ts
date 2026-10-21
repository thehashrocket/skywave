import { TRPCError } from "@trpc/server";
import { KIWI_LIST_URL, LIST_MAX_AGE_MS, LIST_RETRY_MS, parseKiwiList, type Receiver } from "@/lib/kiwi-list";
import { publicProcedure, router } from "../trpc";

const TTL_MS = LIST_MAX_AGE_MS;
// Past this the list is still served (the server only keeps it in memory, so
// it's never older than the process, and Pick best skips receivers that have
// gone), but marked stale so the picker can say how old it is.
const STALE_AFTER_MS = 2 * 60 * 60_000;
// After a failed refresh, keep serving what we have for a minute before
// asking the mirror again, so a down mirror isn't hit on every page load.
const RETRY_AFTER_MS = LIST_RETRY_MS;
// With nothing to serve, retry sooner, so "Try again" isn't a dead button.
const COLD_RETRY_AFTER_MS = 10_000;
const TIMEOUT_MS = 10_000;
// The real file is about 0.9 MB.
const MAX_BYTES = 5_000_000;

type ReceiverList = {
  receivers: Receiver[];
  fetchedAt: number;
  /** The mirror hasn't answered for a while; this copy is more than two hours old. */
  stale: boolean;
};

type Options = { fetchImpl?: typeof fetch; now?: () => number };

/**
 * Fetches the public receiver list at most once per TTL and shares one
 * request between concurrent callers. Once a list is cached, callers never
 * wait on the mirror: an expired list is served while a refresh runs in the
 * background, and kept if that refresh fails.
 */
export function receiverSource({ fetchImpl = (...args) => fetch(...args), now = () => Date.now() }: Options = {}) {
  let cached: ReceiverList | null = null;
  let inflight: Promise<ReceiverList> | null = null;
  let lastFailure: { at: number; error: unknown } | null = null;

  async function refresh(): Promise<ReceiverList> {
    const res = await fetchImpl(KIWI_LIST_URL, {
      // A redirect from a plain-http mirror could point this server at an
      // internal address; treat it as a failed refresh instead.
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "skywave (+https://github.com/thehashrocket/skywave)" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Receiver list request failed: HTTP ${res.status}`);
    return { receivers: parseKiwiList(await readCapped(res)), fetchedAt: now(), stale: false };
  }

  function startRefresh(): Promise<ReceiverList> {
    inflight ??= refresh()
      .then(
        (list) => {
          cached = list;
          lastFailure = null;
          return list;
        },
        (error: unknown) => {
          lastFailure = { at: now(), error };
          throw error;
        },
      )
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return async function get(): Promise<ReceiverList> {
    if (cached && now() - cached.fetchedAt < TTL_MS) return cached;
    const retryAfter = cached ? RETRY_AFTER_MS : COLD_RETRY_AFTER_MS;
    const backingOff = lastFailure !== null && now() - lastFailure.at < retryAfter;
    if (cached) {
      // Nobody awaits a background refresh, so say here when one fails;
      // otherwise a dying mirror stays silent until the cached list expires.
      if (!backingOff) startRefresh().catch((error: unknown) => console.warn("receivers.list: refresh failed:", error));
      return now() - cached.fetchedAt >= STALE_AFTER_MS ? { ...cached, stale: true } : cached;
    }
    if (backingOff) throw lastFailure!.error;
    return startRefresh();
  };
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Receiver list is larger than expected.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const getReceivers = receiverSource();

export const receiversRouter = router({
  list: publicProcedure.query(async () => {
    try {
      const list = await getReceivers();
      // The copy's age by this server's clock, so the browser can time its next
      // poll without comparing two clocks.
      return { ...list, ageMs: Math.max(0, Date.now() - list.fetchedAt) };
    } catch (cause) {
      console.error("receivers.list:", cause);
      throw new TRPCError({ code: "BAD_GATEWAY", message: "Couldn't load the public receiver list.", cause });
    }
  }),
});
