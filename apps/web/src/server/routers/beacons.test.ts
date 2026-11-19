import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The real module opens a Prisma client at import; this router never uses it.
vi.mock("@/server/db", () => ({ db: {} }));

const { beaconStatusSource, rbnSource } = await import("./beacons");
type RbnDay = import("@/lib/rbn").RbnDay;
const { IBP_FOOTNOTES_URL, IBP_STATUS_URL } = await import("@/lib/ibp-status");

const STATUS = readFileSync(new URL("../../lib/fixtures/IBPStatus.csv", import.meta.url), "utf8");
const FOOTNOTES = readFileSync(new URL("../../lib/fixtures/IBPStatusFootnotes.csv", import.meta.url), "utf8");
const HOUR = 60 * 60_000;
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

type Reply = () => Promise<Response>;
const ok = (body: string): Reply => async () => new Response(body);

function setup() {
  let clock = Date.parse("2026-11-19T12:00:00Z");
  let status: Reply = ok(STATUS);
  let footnotes: Reply = ok(FOOTNOTES);
  const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
    String(url) === IBP_STATUS_URL ? status() : footnotes(),
  );
  const defer = vi.fn((_task: Promise<unknown>) => {});
  const get = beaconStatusSource({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, defer });
  const off = async () =>
    (await get())?.beacons.filter((b) => b.off).map((b) => `${b.call}: ${b.note ?? "-"}`) ?? null;
  return {
    get,
    off,
    fetchImpl,
    defer,
    advance: (ms: number) => (clock += ms),
    serve: (s: Reply, f: Reply = footnotes) => {
      status = s;
      footnotes = f;
    },
  };
}

describe("beaconStatusSource", () => {
  // Value: protects=both files are fetched from ncdxf.org without following redirects, joined (each OFF beacon gets its footnote's text), and served from cache for a few hours; fails_when=the wrong URLs are asked for, notes aren't joined, or every request refetches; why_new=issue #69 v1 (cached like the EiBi schedule); seam=fetch; no_claim=ncdxf.org's availability
  it("fetches both files and caches them for a few hours", async () => {
    const { off, fetchImpl, advance } = setup();
    expect(await off()).toEqual([
      "VR2B: The beacon hasn't been heard for a while. We are contacting the operator. If you hear the beacon back on, please report it to us.",
      "YV5B: The beacon is off the air temporarily. We expect it will be back soon.",
    ]);
    expect(fetchImpl.mock.calls.map(([u]) => String(u)).sort()).toEqual([IBP_FOOTNOTES_URL, IBP_STATUS_URL].sort());
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    advance(2 * HOUR);
    await off();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Value: protects=with nothing fetched yet, a failed or wrong status fetch serves null (status unknown, so the page treats every beacon as on the air), never a bundled or made-up copy, and the next try waits ten minutes; fails_when=the query errors, an error page reads as "all on the air" from a cache, or a down site is hit on every request; why_new=issue #69 v1 (no bundled snapshot); seam=fetch; no_claim=none beyond protects
  it.each([
    ["the site is down", () => Promise.reject(new TypeError("fetch failed"))],
    ["it answers with an error", async () => new Response("oops", { status: 404 })],
    ["the file isn't the status file", async () => new Response("<html>moved</html>")],
  ])("serves null until a fetch succeeds when %s", async (_, failure) => {
    const { get, off, fetchImpl, advance, serve } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    serve(failure as Reply);
    expect(await get()).toBeNull();
    const calls = fetchImpl.mock.calls.length;
    expect(await get()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
    advance(10 * 60_000);
    serve(ok(STATUS));
    expect(await off()).toHaveLength(2);
  });

  // Value: protects=the stale-cache fallback: once the cache expires the last good copy is served at once while a refresh runs through defer, and a failed or unreadable refresh keeps it (backing off ten minutes); fails_when=a request waits on ncdxf.org, or a failed refresh drops the status and every beacon shows on the air; why_new=issue #69 v1 (keep the last good copy on failure); seam=fetch, defer; no_claim=none beyond protects
  it("keeps the last good copy through a failed refresh", async () => {
    const { off, fetchImpl, defer, advance, serve } = setup();
    const good = await off();
    advance(4 * HOUR);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    serve(ok("<html>error</html>"));
    expect(await off()).toEqual(good);
    expect(defer).toHaveBeenCalledTimes(1);
    await settled();
    expect(await off()).toEqual(good);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // backing off: no new request yet
    advance(10 * 60_000);
    serve(ok("2026-11-20T00:00:00+00:00\nYV5B,OK,\n"));
    await off();
    await settled();
    expect(await off()).toEqual([]);
  });

  // Value: protects=a failed or unreadable footnotes file doesn't cost the status, and the last good notes stay attached; fails_when=a footnotes outage blanks every note or makes the whole fetch fail; why_new=issue #69 v1 (missing footnote → no text, keep last good); seam=fetch; no_claim=none beyond protects
  it("keeps the last good notes when the footnotes file fails", async () => {
    const { off, advance, serve } = setup();
    const good = await off();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    advance(4 * HOUR);
    serve(ok(STATUS), ok("<html>error</html>"));
    await off();
    await settled();
    expect(await off()).toEqual(good);
  });

  // Value: protects=with the footnotes file down from the start, the status still loads, with no text for its notes; fails_when=the footnotes file is required; why_new=issue #69 v1 (missing footnote → no text); seam=fetch; no_claim=none beyond protects
  it("serves the status without notes when the footnotes never load", async () => {
    const { off, serve } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    serve(ok(STATUS), () => Promise.reject(new TypeError("fetch failed")));
    expect(await off()).toEqual(["VR2B: -", "YV5B: -"]);
  });
});

describe("rbnSource", () => {
  // RBN's real file for 2026-11-18, cut down (fixtures/rbn-20261118-sample.zip).
  const ZIP = readFileSync(new URL("../../lib/fixtures/rbn-20261118-sample.zip", import.meta.url));
  const saved = (day: string, total = 20_000): RbnDay => ({ day, total, beacons: [{ call: "VR2B", spots: 0 }] });

  function setupRbn(at = "2026-11-19T12:00:00Z") {
    let clock = Date.parse(at);
    const rows = new Map<string, RbnDay>();
    const store = {
      load: vi.fn(async (day: string) => rows.get(day) ?? null),
      save: vi.fn(async (d: RbnDay) => {
        rows.set(d.day, d);
      }),
    };
    let reply: () => Promise<Response> = async () => new Response(ZIP);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply());
    const tasks: Promise<unknown>[] = [];
    const defer = vi.fn((task: Promise<unknown>) => {
      tasks.push(task);
    });
    const source = rbnSource({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, defer, store });
    return {
      ...source,
      rows,
      store,
      fetchImpl,
      defer,
      drain: () => Promise.all(tasks),
      advance: (ms: number) => (clock += ms),
      serve: (r: () => Promise<Response>) => {
        reply = r;
      },
    };
  }

  // Value: protects=a day already saved (by any server) is served from the database with no download, and then from memory; fails_when=every server downloads RBN's 6 MB file, or the database is read on every request; why_new=issue #69 v2 (owner: database, once a day); seam=store and fetch injected; no_claim=Postgres itself
  it("serves a saved day without downloading", async () => {
    const r = setupRbn();
    r.rows.set("2026-11-18", saved("2026-11-18"));
    expect((await r.get())?.day).toBe("2026-11-18");
    expect((await r.get())?.day).toBe("2026-11-18");
    expect(r.fetchImpl).not.toHaveBeenCalled();
    expect(r.store.load).toHaveBeenCalledTimes(1);
  });

  // Value: protects=when yesterday isn't saved yet, the request is answered at once from the day before (never waiting on the download) while yesterday's file is downloaded once in the background, counted and saved; later requests get yesterday; fails_when=a request waits on RBN, the download repeats, or the count isn't saved for other servers; why_new=issue #69 v2; seam=store, fetch and defer injected, RBN's real file (cut down); no_claim=RBN's availability
  it("downloads yesterday in the background and saves it", async () => {
    const r = setupRbn();
    r.rows.set("2026-11-17", saved("2026-11-17"));
    expect((await r.get())?.day).toBe("2026-11-17");
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(r.fetchImpl.mock.calls[0]![0])).toBe("https://data.reversebeacon.net/rbn_history/20261118.zip");
    expect(r.fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    expect((await r.get())?.day).toBe("2026-11-17"); // still downloading: no second request
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    await r.drain();
    const day = r.rows.get("2026-11-18")!;
    expect(day.beacons.filter((b) => b.spots === 0).map((b) => b.call)).toEqual(["VR2B", "YV5B"]);
    expect((await r.get())?.day).toBe("2026-11-18");
  });

  // Value: protects=before 01:00 UTC the day before yesterday is the latest asked for (RBN posts just after midnight), and anything older than the day before the target is never shown; fails_when=a half-posted day is asked for, or a stale day keeps marking beacons quiet; why_new=issue #69 v2; seam=store and fetch injected; no_claim=none beyond protects
  it("waits until 01:00 UTC for yesterday, and never serves an older day", async () => {
    const early = setupRbn("2026-11-19T00:30:00Z");
    early.rows.set("2026-11-17", saved("2026-11-17"));
    expect((await early.get())?.day).toBe("2026-11-17");
    expect(early.fetchImpl).not.toHaveBeenCalled();
    const stale = setupRbn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stale.serve(() => Promise.reject(new TypeError("fetch failed")));
    stale.rows.set("2026-11-16", saved("2026-11-16"));
    expect(await stale.get()).toBeNull();
  });

  // Value: protects=a failed or wrong download (RBN's 502 body, an HTTP error) saves nothing, keeps serving the day before, and isn't retried for ten minutes; fails_when=an error page is stored as a day of zeros (every beacon quiet), or RBN is asked on every request while it's down; why_new=issue #69 v2 (RBN answered 502 bodies in testing); seam=store, fetch and defer injected; no_claim=none beyond protects
  it.each([
    ["a 502 body", async () => new Response("error code: 502")],
    ["an HTTP error", async () => new Response("no", { status: 502 })],
    ["the site down", () => Promise.reject(new TypeError("fetch failed"))],
  ])("keeps the day before after %s, and backs off", async (_, failure) => {
    const r = setupRbn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    r.rows.set("2026-11-17", saved("2026-11-17"));
    r.serve(failure as () => Promise<Response>);
    await r.get();
    await r.drain();
    expect(r.store.save).not.toHaveBeenCalled();
    expect((await r.get())?.day).toBe("2026-11-17");
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    r.advance(10 * 60_000);
    r.serve(async () => new Response(ZIP));
    await r.get();
    await r.drain();
    expect((await r.get())?.day).toBe("2026-11-18");
  });

  // Value: protects=peek (what reports.submit uses) reads only what's saved and never starts a download, and a database error reads as nothing rather than failing; fails_when=submitting a report triggers RBN's 6 MB download, or a database hiccup throws into the caller; why_new=issue #69 v2; seam=store and fetch injected; no_claim=none beyond protects
  it("peeks without downloading, and survives a database error", async () => {
    const r = setupRbn();
    r.rows.set("2026-11-17", saved("2026-11-17"));
    expect((await r.peek())?.day).toBe("2026-11-17");
    expect(r.fetchImpl).not.toHaveBeenCalled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = setupRbn();
    broken.store.load.mockRejectedValue(new Error("db down"));
    expect(await broken.peek()).toBeNull();
  });
});
