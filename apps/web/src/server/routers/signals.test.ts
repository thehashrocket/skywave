import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The real module opens a Prisma client at import; this router never uses it.
vi.mock("@/server/db", () => ({ db: {} }));

const { priyomScheduleSource } = await import("./signals");

const EVENTS = readFileSync(new URL("../../lib/fixtures/priyom-events.json", import.meta.url), "utf8");
const HOUR = 60 * 60_000;

type Reply = () => Promise<Response>;
const ok = (body: string): Reply => async () => new Response(body);

function setup() {
  let clock = Date.parse("2026-11-25T13:00:00Z");
  let reply: Reply = ok(EVENTS);
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply());
  const defer = vi.fn((_task: Promise<unknown>) => {});
  const get = priyomScheduleSource({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, defer });
  return {
    get,
    fetchImpl,
    defer,
    advance: (ms: number) => (clock += ms),
    serve: (r: Reply) => (reply = r),
  };
}

describe("priyomScheduleSource", () => {
  // Value: protects=the week is fetched as seven slices without following redirects, merged with duplicates dropped, cut down to the catalog's stations (E07, E11, S06, S11a, V07, M12: not V13, F06a, M14, F03), and cached for hours; fails_when=the page gets every Priyom station, slices double up, or every request refetches; why_new=new feed (#98); seam=fetch; no_claim=Priyom's availability
  it("fetches the week, keeps the catalog's stations, and caches it", async () => {
    const { get, fetchImpl, advance } = setup();
    const schedule = await get();
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    // Every slice returns the same ten events: each appears once.
    expect(schedule?.transmissions.map((t) => t.summary)).toEqual([
      "E11 8102kHz USB",
      "S06 11616kHz USB/AM [Target: Pacific]",
      "S11a 21906kHz USB",
      "M12 12135kHz CW",
      "M12 Search",
      "E07 17428kHz USB",
    ]);
    advance(5 * HOUR);
    await get();
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  // Value: protects=with nothing fetched yet, a failed, wrong or partial fetch (one bad day) serves null (schedule unknown: stations stay listed without times), never a guess, and the next try waits ten minutes; fails_when=the query errors, an error page or a missing day reads as an empty or gappy week, or a down site is hit on every request; why_new=new feed (#98); seam=fetch; no_claim=none
  it.each([
    ["the site is down", () => Promise.reject(new TypeError("fetch failed"))],
    ["it answers with an error", async () => new Response("oops", { status: 503 })],
    ["the body isn't the event list", async () => new Response("<html>moved</html>")],
    ["one slice isn't the event list", (() => {
      let n = 0;
      return async () => new Response(++n === 3 ? '{"error":"limit"}' : EVENTS);
    })()],
  ])("serves null until a fetch succeeds when %s", async (_, failure) => {
    const { get, fetchImpl, advance, serve } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    serve(failure as Reply);
    expect(await get()).toBeNull();
    const calls = fetchImpl.mock.calls.length;
    expect(await get()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
    advance(10 * 60_000);
    serve(ok(EVENTS));
    expect((await get())?.transmissions).toHaveLength(6);
  });

  // Value: protects=once the cache expires the last good week is served at once while a refresh runs through defer, and a failed refresh keeps it; fails_when=a request waits on priyom.org, or a failed refresh drops the schedule; why_new=new feed (#98); seam=fetch, defer; no_claim=none
  it("keeps the last good copy through a failed refresh", async () => {
    const { get, defer, advance, serve } = setup();
    const good = await get();
    advance(7 * HOUR);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    serve(async () => new Response("oops", { status: 500 }));
    expect(await get()).toEqual(good);
    expect(defer).toHaveBeenCalledTimes(1);
    await defer.mock.calls[0]![0];
    expect(await get()).toEqual(good);
  });
});

describe("priyomScheduleSource change log", () => {
  // Value: protects=when a refresh brings different slots, the server logs which stations changed (here a future E07 slot moving from 17428 to 9999 kHz), logs nothing when the week is the same, and ignores slots already past; fails_when=changes go unnoticed (the feed has no change marker) or every refresh logs; why_new=change log (owner asked 2026-11-25); seam=fetch, defer, console.info; no_claim=none
  it("logs stations whose slots changed, and nothing otherwise", async () => {
    const { get, defer, advance, serve } = setup();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await get();
    advance(7 * HOUR);
    await get();
    await defer.mock.calls[0]![0];
    expect(info).not.toHaveBeenCalled();
    serve(ok(EVENTS.replace("E07 17428kHz USB", "E07 9999kHz USB")));
    advance(7 * HOUR);
    await get();
    await defer.mock.calls[1]![0];
    expect(info).toHaveBeenCalledWith("signals.priyom: schedule changed:", "E07: 1 changed");
  });
});
