import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PriyomTx } from "@/lib/priyom-schedule";

// The real module opens a Prisma client at import; this router never uses it.
vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("./stations", async (actual) => {
  const { forPage, parseEibi } = await import("@/lib/eibi");
  const snapshot = (await import("../eibi-snapshot.json")).default;
  const broadcasts = parseEibi(snapshot.csv, snapshot.season).map(forPage);
  return {
    ...(await actual<typeof import("./stations")>()),
    getSchedule: vi.fn(async () => ({ season: snapshot.season, bundled: true, broadcasts, listed: broadcasts, targetNames: {} })),
  };
});

const { priyomScheduleSource, lastHeardSource, readPriyomFeed, recordPriyomFetch, LAST_HEARD_READ_TIMEOUT_MS, LAST_HEARD_TTL_MS } =
  await import("./signals");
const { appRouter } = await import("@/server/root");
const { PRIYOM_SLICES } = await import("@/lib/priyom-schedule");
const { COUNT_MS, NOT_HEARD_OVER_OTHER } = await import("@/lib/signal-heard");
const { groupedTalliesSql } = await import("@/server/grouped-tallies");

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
  // Value: protects=the week is fetched as PRIYOM_SLICES slices without following redirects, merged with duplicates dropped, cut down to the catalog's stations (E07, E11, S06, S11a, M12, and F06a filed under F06 with its designator kept, #148; not V13, M14, F03), and cached for hours; fails_when=the page gets every Priyom station, F06a is dropped or loses its designator, slices double up, or every request refetches; why_new=new feed (#98), F06a decision (#148); seam=fetch; no_claim=Priyom's availability
  it("fetches the week, keeps the catalog's stations, and caches it", async () => {
    const { get, fetchImpl, advance } = setup();
    const schedule = await get();
    expect(fetchImpl).toHaveBeenCalledTimes(PRIYOM_SLICES);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    // Every slice returns the same ten events: each appears once.
    expect(schedule?.transmissions.map((t) => t.summary)).toEqual([
      "F06a 17532kHz RTTY [Target: Pacific]",
      "E11 8102kHz USB",
      "S06 11616kHz USB/AM [Target: Pacific]",
      "S11a 21906kHz USB",
      "M12 12135kHz CW",
      "M12 Search",
      "E07 17428kHz USB",
    ]);
    expect(schedule?.transmissions.find((t) => t.summary.startsWith("F06a"))).toMatchObject({ station: "F06", designator: "F06a" });
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
    expect((await get())?.transmissions).toHaveLength(7);
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

describe("priyomScheduleSource record and status", () => {
  // Value: protects=#147 each good fetch is handed to `record` after the response (through defer), a failing record is only logged and the schedule still served, and status() says what this server's copy is and why its last fetch failed; fails_when=the shared record never hears of fetches (the report can't see Priyom changing), a database error breaks the schedule, or a fetch error isn't reported; why_new=#147 persisted last change; seam=fetch, defer, record; no_claim=the database write itself
  it("records good fetches and reports its status", async () => {
    let clock = Date.parse("2026-11-25T13:00:00Z");
    let fail = true;
    const fetchImpl = vi.fn(async () => (fail ? new Response("oops", { status: 503 }) : new Response(EVENTS)));
    const defer = vi.fn((_task: Promise<unknown>) => {});
    const record = vi.fn(async () => {
      throw new Error("db down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = priyomScheduleSource({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, defer, record });
    expect(await get()).toBeNull();
    expect(get.status()).toEqual({ fetchedAt: null, error: "Priyom schedule request failed: HTTP 503" });
    expect(record).not.toHaveBeenCalled();
    fail = false;
    clock += 10 * 60_000;
    const schedule = await get();
    expect(schedule?.transmissions).toHaveLength(7);
    expect(get.status()).toEqual({ fetchedAt: clock, error: null });
    expect(record).toHaveBeenCalledWith(schedule);
    await defer.mock.calls[0]![0];
    expect(warn).toHaveBeenCalledWith("signals.priyom: not recorded:", expect.any(Error));
    warn.mockRestore();
  });

  // Value: protects=#147 outside a request (`after` throws), a good fetch is still served and still handed to `record`; fails_when=the throw from defer escapes the success handler, so the fetch reads as failed (null schedule, ten-minute backoff) and nothing is recorded; why_new=saveCopy's not-in-a-request branch had no test; seam=fetch, defer, record; no_claim=Next's `after` behaviour itself
  it("still serves and records when there's no request to defer to", async () => {
    const clock = Date.parse("2026-11-25T13:00:00Z");
    const record = vi.fn(async () => {});
    const defer = vi.fn((_task: Promise<unknown>) => {
      throw new Error("`after` was called outside a request scope");
    });
    const fetchImpl = async () => new Response(EVENTS);
    const get = priyomScheduleSource({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, defer, record });
    const schedule = await get();
    expect(schedule?.transmissions).toHaveLength(7);
    expect(record).toHaveBeenCalledWith(schedule);
    expect(get.status()).toEqual({ fetchedAt: clock, error: null });
  });

  // Value: protects=#147 review D2: refreshNow fetches even while the cached copy is still within its TTL, resolves only after that copy's save finished, and on a failed fetch returns the last copy with the error in status() instead of throwing; fails_when=the report reads a copy or record a quiet week left old, or a Priyom outage makes the weekly route 502; why_new=owner chose refresh-then-judge; seam=fetch, defer, record; no_claim=Priyom's real latency
  it("refreshNow fetches now and waits for the save", async () => {
    let clock = Date.parse("2026-11-25T13:00:00Z");
    let fail = false;
    const fetchImpl = vi.fn(async () => (fail ? new Response("oops", { status: 503 }) : new Response(EVENTS)));
    const saved: number[] = [];
    const record = vi.fn(async (copy: { fetchedAt: number }) => {
      await new Promise((r) => setTimeout(r, 5));
      saved.push(copy.fetchedAt);
    });
    const get = priyomScheduleSource({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, defer: () => {}, record });
    await get();
    const calls = fetchImpl.mock.calls.length;
    clock += 60 * 60_000; // an hour later: still within the six-hour cache
    const fresh = await get.refreshNow();
    expect(fetchImpl.mock.calls.length).toBe(calls * 2);
    expect(fresh?.fetchedAt).toBe(clock);
    expect(saved).toContain(clock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fail = true;
    clock += 60_000;
    const kept = await get.refreshNow();
    expect(kept?.fetchedAt).toBe(clock - 60_000);
    expect(get.status()).toEqual({ fetchedAt: clock - 60_000, error: "Priyom schedule request failed: HTTP 503" });
  });
});

describe("recordPriyomFetch and readPriyomFeed", () => {
  type Db = Parameters<typeof recordPriyomFetch>[0];
  const t0 = Date.parse("2026-11-25T13:00:00Z");
  const e07 = (khz: number): PriyomTx => ({ station: "E07", startMs: Date.parse("2026-11-27T19:00:00Z"), khz, mode: "usb", summary: `E07 ${khz}kHz USB` });

  /** One PriyomFeed table in memory: upsert stores what it's given, findUnique hands it back. */
  function fakeDb() {
    let row: Record<string, unknown> | null = null;
    const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "priyom" ? row : null));
    const upsert = vi.fn(async ({ where, create, update }: { where: { id: string }; create: object; update: object }) => {
      expect(where).toEqual({ id: "priyom" });
      row = row ? { ...row, ...update } : { ...create };
    });
    return { db: { priyomFeed: { findUnique, upsert } } as unknown as Db, upsert };
  }

  // Value: protects=#147 the shared row round-trips through the database: the first fetch starts tracking with no change, a later identical fetch moves only fetchedAt, a fetch with a moved slot sets changedAt to that fetch, and an older copy (another instance got there first) writes nothing; fails_when=dates are stored or read back wrong (changedAt null turning into a date, ms vs Date), the row is never written, or a stale copy overwrites a newer one; why_new=recordPriyomFetch and readPriyomFeed had no test (the route test mocks the row); seam=db object passed in (in-memory fake); no_claim=Prisma/Postgres JSON and timestamp handling, or two instances racing
  it("keeps one row with the last copy and when the slots last changed", async () => {
    const { db, upsert } = fakeDb();
    expect(await readPriyomFeed(db)).toBeNull();
    await recordPriyomFetch(db, { transmissions: [e07(17_428)], fetchedAt: t0 });
    expect(await readPriyomFeed(db)).toEqual({ transmissions: [e07(17_428)], fetchedAt: t0, trackedSince: t0, changedAt: null });
    await recordPriyomFetch(db, { transmissions: [e07(17_428)], fetchedAt: t0 + 6 * HOUR });
    expect(await readPriyomFeed(db)).toMatchObject({ fetchedAt: t0 + 6 * HOUR, trackedSince: t0, changedAt: null });
    await recordPriyomFetch(db, { transmissions: [e07(9_999)], fetchedAt: t0 + 12 * HOUR });
    const changed = await readPriyomFeed(db);
    expect(changed).toEqual({ transmissions: [e07(9_999)], fetchedAt: t0 + 12 * HOUR, trackedSince: t0, changedAt: t0 + 12 * HOUR });
    expect(upsert).toHaveBeenCalledTimes(3);
    await recordPriyomFetch(db, { transmissions: [], fetchedAt: t0 + 7 * HOUR });
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(await readPriyomFeed(db)).toEqual(changed);
  });
});

describe("lastHeardSource", () => {
  type Row = { txKind: string; txName: string; freqKhz: number; outcome: string; createdAt: Date; askGroup?: string };
  const NOW = Date.parse("2026-11-25T12:00:00Z");
  const row = (txKind: string, txName: string, khz: number, outcome: string, agoMin: number): Row => ({
    txKind,
    txName,
    freqKhz: khz,
    outcome,
    createdAt: new Date(NOW - agoMin * 60_000),
  });
  type Range<T> = { gte: T; lte: T };
  type Where = { txKind: string; outcome?: string; createdAt: Range<Date>; freqKhz?: Range<number>; askGroup?: null };
  type GroupBy = { by: ("txName" | "outcome")[]; where: Where; _max?: { createdAt: true }; _count?: { _all: true } };

  /** A ReceptionReport table answering groupBy the way Postgres would for the filters signals.lastHeard uses. */
  function fakeDb(rows: Row[], grouped: { txName: string; outcome: string; n: number }[] = []) {
    const within = <T>(v: T, r: Range<T>) => v >= r.gte && v <= r.lte;
    const groupBy = vi.fn(async ({ by, where, _max, _count }: GroupBy) => {
      const groups = new Map<string, Row[]>();
      for (const r of rows) {
        if (r.txKind !== where.txKind || (where.outcome !== undefined && r.outcome !== where.outcome)) continue;
        if (where.askGroup === null && r.askGroup !== undefined) continue;
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
    // Shared-frequency answers' tallies (#150), as server/grouped-tallies.ts's SQL sums them.
    const queryRaw = vi.fn(async (..._args: unknown[]) => grouped);
    return { db: { receptionReport: { groupBy }, $queryRawUnsafe: queryRaw } as never, groupBy, reads, queryRaw };
  }

  // Value: protects=a shared-frequency "Heard WWV" (#150) badges WWV alone, never "WWV or WWVH heard" on WWVH, which the same answer said wasn't heard, while an older single-station heard on the shared channel still shows on both; fails_when=the shared-channel read takes grouped rows, so WWVH looks heard moments after a listener said it wasn't; why_new=#150 review; seam=groupBy faked (askGroup null honoured); no_claim=Postgres behavior
  it("badges a grouped heard on its own station only", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const grouped = (outcome: string, txName: string): Row => ({ ...row("signal", txName, 10_000, outcome, 5), askGroup: "g1" });
      const { db } = fakeDb([grouped("heard", "wwv"), grouped("not_heard", "wwvh")]);
      const { heard } = await lastHeardSource({ now: () => NOW })(db);
      expect(heard.wwv).toMatchObject({ heardMs: NOW - 5 * 60_000, either: null });
      expect(heard.wwvh?.heardMs ?? null).toBeNull();
      const older = fakeDb([grouped("heard", "wwv"), row("signal", "wwvh", 10_000, "heard", 60)]);
      const both = await lastHeardSource({ now: () => NOW })(older.db);
      expect(both.heard.wwvh).toMatchObject({ heardMs: NOW - 60 * 60_000, either: ["WWV", "WWVH"] });
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=the badges' day counts add shared-frequency answers (#150) without counting "not heard over the other" as not heard (owner, #150): WWVH not heard beside a heard WWV adds nothing to WWVH's not-heard count, while a group's plain not-heard and heard do count; the grouped read covers the day's window, not grouped by listener; fails_when=grouped answers are left out of the counts, or every "Heard WWV" adds a WWVH not-heard; why_new=#150 review; seam=groupBy and the grouped SQL faked (the SQL is in grouped-tallies.test); no_claim=Postgres behavior
  it("counts shared-frequency answers, but not WWVH not heard over WWV", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const { db, queryRaw } = fakeDb(
        [row("signal", "wwvh", 10_000, "heard", 30)],
        [
          { txName: "wwv", outcome: "heard", n: 4 },
          { txName: "wwvh", outcome: NOT_HEARD_OVER_OTHER, n: 4 },
          { txName: "wwvh", outcome: "not_heard", n: 1 },
        ],
      );
      // A source of its own, so the router's cached answer is neither read nor left behind.
      const { heard } = await lastHeardSource({ now: () => NOW })(db);
      expect(heard.wwv).toMatchObject({ heard24h: 4, notHeard24h: 0 });
      expect(heard.wwvh).toMatchObject({ heard24h: 1, notHeard24h: 1 });
      expect(queryRaw).toHaveBeenCalledWith(groupedTalliesSql(false), new Date(NOW - COUNT_MS), new Date(NOW));
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=signals.lastHeard sums only signal answers from the last week per station (a beacon or EiBi row never badges a station; mixed answers give the latest heard and day counts; a week-old heard is dropped; a heard from two days ago badges but stays out of the day's counts); fails_when=another kind's rows leak in, the window is wrong (including the counts reading the week window instead of COUNT_MS), or the query isn't wired to the router; why_new=#102 query; the 2-day row added because no fixture sat between COUNT_MS and HEARD_SHOWN_MS; seam=ctx.db.receptionReport.groupBy faked; no_claim=Postgres behavior (checked against a real Postgres in /ship QA)
  it("sums the week's signal answers per station", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const { db } = fakeDb([
        row("signal", "uvb-76", 4_625, "heard", 40),
        row("signal", "uvb-76", 4_625, "not_heard", 20),
        row("beacon", "uvb-76", 4_625, "heard", 1),
        row("signal", "the-pip", 5_448, "heard", 8 * 24 * 60),
        row("signal", "rwm", 9_996, "heard", 2 * 24 * 60),
      ]);
      const caller = appRouter.createCaller({ db } as never);
      const { heard } = await caller.signals.lastHeard();
      expect(heard).toEqual({
        "uvb-76": { heardMs: NOW - 40 * 60_000, either: null, heard24h: 1, notHeard24h: 1 },
        rwm: { heardMs: NOW - 2 * 24 * 60 * 60_000, either: null, heard24h: 0, notHeard24h: 0 },
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

  // Value: protects=the answer is cached for LAST_HEARD_TTL_MS, longer than Neon's five idle minutes before it sleeps (owner decision on the #102 review), however many pages poll; concurrent callers share one read; a failed read serves the last good answer and waits a TTL before reading again; fails_when=the TTL is cut so the database never sleeps, every request hits the database (healthy or failing), or a database blip errors the badges away; why_new=#102 server cache, backoff and TTL from the #102 review; seam=groupBy faked, clock injected; no_claim=Neon's actual autosuspend setting
  it("caches past Neon's idle window and keeps the last answer through a failed read", async () => {
    expect(LAST_HEARD_TTL_MS).toBeGreaterThan(5 * 60_000);
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

  // Value: protects=#102 review: a read that never settles (a database resuming, a half-open socket) fails after LAST_HEARD_READ_TIMEOUT_MS, so the instance serves its last answer and later reads aren't pinned to the hung one; fails_when=the timeout is dropped and every later request awaits the hung read forever; why_new=Red Team (shared in-flight read with no timeout); seam=groupBy faked, fake timers; no_claim=the hung query's connection is still held until the driver gives up
  it("gives up on a read that hangs and serves the last answer", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      let clock = NOW;
      const get = lastHeardSource({ now: () => clock });
      const { db, groupBy } = fakeDb([row("signal", "rwm", 9_996, "heard", 5)]);
      const first = await get(db);
      clock += LAST_HEARD_TTL_MS;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      groupBy.mockImplementation(() => new Promise(() => {}));
      const hung = get(db);
      await vi.advanceTimersByTimeAsync(LAST_HEARD_READ_TIMEOUT_MS);
      expect(await hung).toBe(first);
      const fresh = lastHeardSource({ now: () => clock });
      const cold = fresh(db);
      const rejected = expect(cold).rejects.toThrow(`read took over ${LAST_HEARD_READ_TIMEOUT_MS} ms`);
      await vi.advanceTimersByTimeAsync(LAST_HEARD_READ_TIMEOUT_MS);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=with no answer cached yet, a failed read reaches the page as an error (it then shows no badges) rather than an empty answer that reads as "nobody heard anything", and the instance backs off for a TTL instead of reading on every request (#102 review); fails_when=a database outage looks like silence, or a fresh instance hammers a sleeping or failing database; why_new=#102, cold-instance backoff from the #102 review; seam=groupBy faked, clock injected; no_claim=none
  it("fails when the first read fails, then backs off", async () => {
    let clock = NOW;
    const get = lastHeardSource({ now: () => clock });
    const { db, groupBy } = fakeDb([]);
    groupBy.mockRejectedValue(new Error("db down"));
    await expect(get(db)).rejects.toThrow("db down");
    const calls = groupBy.mock.calls.length;
    clock += LAST_HEARD_TTL_MS - 1;
    await expect(get(db)).rejects.toThrow("db down");
    expect(groupBy.mock.calls.length).toBe(calls);
    clock += 1;
    groupBy.mockReset();
    const { db: healthy } = fakeDb([row("signal", "rwm", 9_996, "heard", 5)]);
    expect((await get(healthy)).heard["rwm"]).toMatchObject({ heardMs: NOW - 5 * 60_000 });
  });
});

describe("signals.dayNight", () => {
  // Value: protects=#168 the station page's query is on the app router and answers with the day/night stations' rows built from the server's EiBi copy (getSchedule), The Pip's Nov-Feb night row among them; fails_when=the procedure is dropped or renamed (the page's useDayNightRows fails and it follows the sun), or it answers from something other than the server's schedule; why_new=review: the procedure itself was untested; seam=getSchedule mocked with the bundled B26 snapshot; no_claim=the slice's contents (on-air.test dayNightRows)
  it("serves the day/night stations' rows from the server's schedule", async () => {
    const caller = appRouter.createCaller({ db: {} } as never);
    const rows = await caller.signals.dayNight();
    expect(new Set(rows.map((r) => r.slug))).toEqual(new Set(["the-pip", "squeaky-wheel"]));
    expect(rows).toContainEqual(expect.objectContaining({ slug: "the-pip", khz: 3_756, start: 14 * 60, end: 5 * 60 + 30 }));
  });
});
