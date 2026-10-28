import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// The real module opens a Prisma client at import; this router never uses it.
vi.mock("@/server/db", () => ({ db: {} }));

const { receiverSource } = await import("./receivers");

const FIXTURE = readFileSync(new URL("../../lib/fixtures/kiwisdr_com.txt", import.meta.url), "utf8");
const MINUTE = 60_000;
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  let clock = 1_000_000;
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(FIXTURE));
  // Next's `after` needs a request scope; these tests have none.
  const defer = vi.fn((_task: Promise<unknown>) => {});
  const get = receiverSource({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, defer });
  return {
    get,
    fetchImpl,
    defer,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("receiverSource", () => {
  it("fetches once and serves the cached list within 15 minutes", async () => {
    const { get, fetchImpl, advance } = setup();
    const first = await get();
    advance(14 * MINUTE);
    expect(await get()).toBe(first);
    expect(first.receivers).toHaveLength(7);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches after 15 minutes", async () => {
    const { get, fetchImpl, advance } = setup();
    await get();
    advance(15 * MINUTE);
    await get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent callers", async () => {
    const { get, fetchImpl } = setup();
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses redirects", async () => {
    const { get, fetchImpl } = setup();
    await get();
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });

  it.each([
    ["the mirror is down", () => Promise.reject(new TypeError("fetch failed"))],
    ["the mirror returns an error page", async () => new Response("oops", { status: 503 })],
    ["the format changed", async () => new Response("<html>moved</html>")],
  ])("keeps the last good list when %s", async (_, failure) => {
    const { get, fetchImpl, advance } = setup();
    const good = await get();
    advance(16 * MINUTE);
    fetchImpl.mockImplementationOnce(failure);
    expect(await get()).toBe(good);
    await settled(); // the failed background refresh must not replace it
    expect(await get()).toBe(good);
  });

  it("waits a minute before asking a failing mirror again", async () => {
    const { get, fetchImpl, advance } = setup();
    await get();
    advance(16 * MINUTE);
    fetchImpl.mockRejectedValue(new TypeError("fetch failed"));
    await get();
    await settled(); // the refresh runs in the background; let its failure land
    advance(30_000);
    await get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    advance(31_000);
    await get();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  // Value: protects=an expired list is served at once while the mirror is slow; fails_when=get() awaits the refresh again; why_new=earlier tests only used instant fetches; seam=none; no_claim=real network latency
  it("serves the expired list right away and refreshes in the background", async () => {
    const { get, fetchImpl, advance } = setup();
    const old = await get();
    advance(16 * MINUTE);
    let finish!: (r: Response) => void;
    fetchImpl.mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
    expect(await get()).toBe(old);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    finish(new Response(FIXTURE));
    await vi.waitFor(async () => expect(await get()).not.toBe(old));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Value: protects=a background refresh outlives the response on Vercel; fails_when=the expired-list branch stops handing its refresh to defer, or hands over one that can reject; why_new=no test saw where the refresh promise went; seam=defer option (production passes Next's after); no_claim=Vercel's real suspend behavior
  it("hands the background refresh to defer, and only that", async () => {
    const { get, fetchImpl, defer, advance } = setup();
    await get(); // a cold load is awaited, not deferred
    advance(14 * MINUTE);
    await get();
    expect(defer).not.toHaveBeenCalled();

    advance(2 * MINUTE);
    fetchImpl.mockRejectedValueOnce(new TypeError("fetch failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await get();
    expect(defer).toHaveBeenCalledTimes(1);
    // The deferred task logs its failure instead of rejecting.
    await expect(defer.mock.calls[0]![0]).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("receivers.list: refresh failed:", expect.any(TypeError));
    warn.mockRestore();
  });

  // Value: protects=a down mirror isn't hit on every page load during a cold start, yet "Try again" works soon; fails_when=the cold path ignores the retry window or uses the full minute; why_new=D5 shortened the cold window to 10 s; seam=none; no_claim=real network
  it("waits 10 seconds before asking a failing mirror again when nothing is cached", async () => {
    const { get, fetchImpl, advance } = setup();
    fetchImpl.mockRejectedValue(new TypeError("fetch failed"));
    await expect(get()).rejects.toThrow("fetch failed");
    advance(9_000);
    await expect(get()).rejects.toThrow("fetch failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    advance(2_000);
    fetchImpl.mockResolvedValueOnce(new Response(FIXTURE));
    await expect(get()).resolves.toMatchObject({ stale: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Value: protects=a long mirror outage keeps Browse and Pick best working on a list marked stale; fails_when=the old list is dropped (BAD_GATEWAY) or served without the flag; why_new=D7 reversed the 2-hour cutoff; seam=none; no_claim=real outage timing
  it("keeps serving a list more than two hours old, marked stale", async () => {
    const { get, fetchImpl, advance } = setup();
    const good = await get();
    expect(good.stale).toBe(false);
    fetchImpl.mockRejectedValue(new TypeError("fetch failed"));
    advance(119 * MINUTE);
    await expect(get()).resolves.toMatchObject({ stale: false });
    await settled();
    advance(2 * MINUTE);
    const old = await get();
    expect(old).toMatchObject({ stale: true, fetchedAt: good.fetchedAt });
    expect(old.receivers).toBe(good.receivers);

    await settled();
    advance(61_000);
    fetchImpl.mockResolvedValueOnce(new Response(FIXTURE));
    await get();
    await vi.waitFor(async () => expect((await get()).stale).toBe(false));
  });

  it("throws when the first fetch fails and there's nothing cached", async () => {
    const { get, fetchImpl } = setup();
    fetchImpl.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(get()).rejects.toThrow("fetch failed");
  });

  it("rejects a response far larger than the real list", async () => {
    const { get, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(new Response("x".repeat(5_000_001)));
    await expect(get()).rejects.toThrow(/larger than expected/);
  });
});

describe("unbatched tRPC paths", () => {
  // Value: protects=the slow mirror call stays out of the batch; fails_when=receivers.list is renamed and the client's split silently stops matching; why_new=the path was an untyped string; seam=none; no_claim=network behaviour of httpLink
  it("all name real procedures", async () => {
    const { appRouter } = await import("@/server/root");
    const { UNBATCHED_PATHS } = await import("@/lib/unbatched");
    for (const path of UNBATCHED_PATHS) expect(Object.keys(appRouter._def.procedures)).toContain(path);
  });
});

describe("receivers.list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("turns a failed first load into a clean BAD_GATEWAY", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { appRouter } = await import("@/server/root");
    const caller = appRouter.createCaller({ db: {} } as never);

    await expect(caller.receivers.list()).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: "Couldn't load the public receiver list.",
    });
  });

  // Value: protects=the browser can time its poll from the server's own clock; fails_when=list stops reporting ageMs or measures it from another clock; why_new=red team + Claude adversarial (PR 1): clock skew; seam=fake system time; no_claim=network latency
  it("reports how old its copy is by its own clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Past the failed load's 10-second cold retry above.
      vi.setSystemTime(Date.now() + 60_000);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(FIXTURE)),
      );
      const { appRouter } = await import("@/server/root");
      const caller = appRouter.createCaller({ db: {} } as never);
      expect((await caller.receivers.list()).ageMs).toBe(0);
      vi.setSystemTime(Date.now() + 5 * MINUTE);
      expect((await caller.receivers.list()).ageMs).toBe(5 * MINUTE);
    } finally {
      vi.useRealTimers();
    }
  });
});
