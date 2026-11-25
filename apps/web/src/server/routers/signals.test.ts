import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The real module opens a Prisma client at import; this router never uses it.
vi.mock("@/server/db", () => ({ db: {} }));

const { priyomScheduleSource, lastHeardSource, LAST_HEARD_TTL_MS } = await import("./signals");
const { appRouter } = await import("@/server/root");
const { PRIYOM_SLICES } = await import("@/lib/priyom-schedule");

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
  // Value: protects=the week is fetched as PRIYOM_SLICES slices without following redirects, merged with duplicates dropped, cut down to the catalog's stations (E07, E11, S06, S11a, V07, M12: not V13, F06a, M14, F03), and cached for hours; fails_when=the page gets every Priyom station, slices double up, or every request refetches; why_new=new feed (#98); seam=fetch; no_claim=Priyom's availability
  it("fetches the week, keeps the catalog's stations, and caches it", async () => {
    const { get, fetchImpl, advance } = setup();
    const schedule = await get();
    expect(fetchImpl).toHaveBeenCalledTimes(PRIYOM_SLICES);
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
    expect(fetchImpl).toHaveBeenCalledTimes(PRIYOM_SLICES);
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

describe("lastHeardSource", () => {
  type Row = { txKind: string; txName: string; freqKhz: number; outcome: string; createdAt: Date };
  const NOW = Date.parse("2026-11-25T12:00:00Z");
  const row = (txKind: string, txName: string, khz: number, outcome: string, agoMin: number): Row => ({
    txKind,
    txName,
    freqKhz: khz,
    outcome,
    createdAt: new Date(NOW - agoMin * 60_000),
  });
  type Range<T> = { gte: T; lte: T };
  type Where = { txKind: string; outcome?: string; createdAt: Range<Date>; freqKhz?: Range<number> };
  type GroupBy = { by: ("txName" | "outcome")[]; where: Where; _max?: { createdAt: true }; _count?: { _all: true } };

  /** A ReceptionReport table answering groupBy the way Postgres would for the filters signals.lastHeard uses. */
  function fakeDb(rows: Row[]) {
    const within = <T>(v: T, r: Range<T>) => v >= r.gte && v <= r.lte;
    const groupBy = vi.fn(async ({ by, where, _max, _count }: GroupBy) => {
      const groups = new Map<string, Row[]>();
      for (const r of rows) {
        if (r.txKind !== where.txKind || (where.outcome !== undefined && r.outcome !== where.outcome)) continue;
        if (!within(r.createdAt, where.createdAt) || (where.freqKhz && !within(r.freqKhz, where.freqKhz))) continue;
        const key = by.map((k) => r[k]).join("\u0000");
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      return [...groups.values()].map((g) => ({
        ...Object.fromEntries(by.map((k) => [k, g[0]![k]])),
        ...(_max && { _max: { createdAt: new Date(Math.max(...g.map((r) => r.createdAt.getTime()))) } }),
        ...(_count && { _count: { _all: g.length } }),
      }));
    });
    /** How many reads ran: each read counts answers by outcome once. */
    const reads = () => groupBy.mock.calls.filter(([a]) => a.by.includes("outcome")).length;
    return { db: { receptionReport: { groupBy } } as never, groupBy, reads };
  }

  // Value: protects=signals.lastHeard sums only signal answers from the last week per station (a beacon or EiBi row never badges a station; mixed answers give the latest heard and day counts; a week-old heard is dropped); fails_when=another kind's rows leak in, the window is wrong, or the query isn't wired to the router; why_new=#102 query; seam=ctx.db.receptionReport.groupBy faked; no_claim=Postgres behavior (checked against a real Postgres in /ship QA)
  it("sums the week's signal answers per station", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const { db } = fakeDb([
        row("signal", "uvb-76", 4_625, "heard", 40),
        row("signal", "uvb-76", 4_625, "not_heard", 20),
        row("beacon", "uvb-76", 4_625, "heard", 1),
        row("signal", "the-pip", 5_448, "heard", 8 * 24 * 60),
      ]);
      const caller = appRouter.createCaller({ db } as never);
      const { heard } = await caller.signals.lastHeard();
      expect(heard).toEqual({
        "uvb-76": { heardMs: NOW - 40 * 60_000, either: null, heard24h: 1, notHeard24h: 1 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=#102 review: a flood of answers about one station can't take another station's badge away (the newest heard is summed per station by the database, not cut from a capped row list), and a heard on 5 MHz still credits WWV and WWVH together; fails_when=the read goes back to a capped or global row list, or drops the shared-channel sums; why_new=four reviewers found the 5,000-row cap dropping real badges; seam=groupBy faked; no_claim=Postgres timing under a real flood
  it("keeps every station's newest heard however many answers another station gets", async () => {
    const flood = Array.from({ length: 6_000 }, (_, i) => row("signal", "uvb-76", 4_625, i % 2 ? "heard" : "not_heard", 1 + i / 1_000));
    const { db } = fakeDb([...flood, row("signal", "rwm", 9_996, "heard", 3 * 24 * 60), row("signal", "wwvh", 5_000, "heard", 90)]);
    const { heard } = await lastHeardSource({ now: () => NOW })(db);
    expect(heard["rwm"]).toMatchObject({ heardMs: NOW - 3 * 24 * 60 * 60_000, either: null });
    expect(heard["wwv"]).toMatchObject({ heardMs: NOW - 90 * 60_000, either: ["WWV", "WWVH"] });
    expect(heard["uvb-76"]).toMatchObject({ heard24h: 3_000, notHeard24h: 3_000 });
  });

  // Value: protects=owner rule on #102 end to end: WWV's own newer heard on 20 MHz (a frequency WWVH doesn't use) stays WWV's alone, while a WWVH heard a dial step off 10 MHz (within ON_KHZ) still reads "WWV or WWVH" on both rows; fails_when=the shared-channel query loses its freqKhz range (every heard becomes "shared", so WWVH's row shows WWV's 20 MHz answer) or the range shrinks below ON_KHZ (an off-by-a-step 10 MHz answer goes to WWVH alone); why_new=the router tests only had an exact 5 MHz answer, which passes with the range dropped or exact; seam=groupBy faked; no_claim=Postgres float comparison on freqKhz
  it("keeps WWV's 20 MHz heard its own and shares a 10 MHz one within the dial step", async () => {
    const { db } = fakeDb([row("signal", "wwv", 20_000, "heard", 10), row("signal", "wwvh", 9_999.97, "heard", 60)]);
    const { heard } = await lastHeardSource({ now: () => NOW })(db);
    expect(heard["wwv"]).toMatchObject({ heardMs: NOW - 10 * 60_000, either: null });
    expect(heard["wwvh"]).toMatchObject({ heardMs: NOW - 60 * 60_000, either: ["WWV", "WWVH"] });
  });

  // Value: protects=the answer is cached for LAST_HEARD_TTL_MS (one read a minute however many pages poll), concurrent callers share one read, and a failed read serves the last good answer and waits a TTL before reading again; fails_when=every request hits the database (healthy or failing), or a database blip errors the badges away; why_new=#102 server cache, backoff from the #102 review; seam=groupBy faked, clock injected; no_claim=none
  it("caches for a minute and keeps the last answer through a failed read", async () => {
    let clock = NOW;
    const get = lastHeardSource({ now: () => clock });
    const { db, groupBy, reads } = fakeDb([row("signal", "rwm", 9_996, "heard", 5)]);
    const [a, b] = await Promise.all([get(db), get(db)]);
    expect(a).toBe(b);
    expect(reads()).toBe(1);
    clock += LAST_HEARD_TTL_MS - 1;
    await get(db);
    expect(reads()).toBe(1);
    clock += 1;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    groupBy.mockRejectedValueOnce(new Error("db down"));
    expect(await get(db)).toBe(a);
    const callsAfterFailure = groupBy.mock.calls.length;
    // Backing off: the last answer again, without asking the database.
    clock += LAST_HEARD_TTL_MS - 1;
    expect(await get(db)).toBe(a);
    expect(groupBy.mock.calls.length).toBe(callsAfterFailure);
    clock += 1;
    expect((await get(db)).at).toBe(clock);
    expect(groupBy.mock.calls.length).toBeGreaterThan(callsAfterFailure);
  });

  // Value: protects=with no answer cached yet, a failed read reaches the page as an error (it then shows no badges) rather than an empty answer that reads as "nobody heard anything"; fails_when=a database outage looks like silence; why_new=#102; seam=groupBy faked; no_claim=none
  it("fails when the first read fails", async () => {
    const get = lastHeardSource({ now: () => NOW });
    const { db, groupBy } = fakeDb([]);
    groupBy.mockRejectedValue(new Error("db down"));
    await expect(get(db)).rejects.toThrow("db down");
  });
});
