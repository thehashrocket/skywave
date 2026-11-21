import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The real module opens a Prisma client at import; this router never uses it.
vi.mock("@/server/db", () => ({ db: {} }));

const { beaconStatusSource, rbnSource, saveSkimmerDay, SKIMMERS_MAX_REFUSALS, SKIMMERS_MAX_SHORT_REFUSALS } = await import("./beacons");
type SkimmerDay = import("./beacons").SkimmerDay;
type SkimmerRefusal = import("./beacons").SkimmerRefusal;
const { RBN_MIN_SKIMMERS, RBN_SKIMMERS_URL } = await import("@/lib/rbn");
const { gunzipSync } = await import("node:zlib");
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

describe("saveSkimmerDay", () => {
  const row = (call: string) =>
    `<tr><td><a href="/x?c=${call}&t=de">${call}</a></td><td>20m</td><td>jo22ab</td><td><a href="?id_dxcc_de=1">ZZ</a></td>` +
    `<td><a href="?id_cont_de=EU">EU</a></td><td><a href="?id_itu_z_de=1">1</a></td><td><a href="?id_cq_z_de=1">1</a></td>` +
    `<td><b class="hide">0000000100</b> 1 day ago</td><td><b class="hide">0000000030</b> online</td></tr>`;
  const PAGE = Array.from({ length: RBN_MIN_SKIMMERS }, (_, i) => row(`S${i}X`)).join("\n");

  function setupSkimmers(at = "2026-11-20T01:30:00Z") {
    let clock = Date.parse(at);
    const days = new Map<string, SkimmerDay>();
    const refusals: SkimmerRefusal[] = [];
    const store = {
      has: vi.fn(async (day: string) => days.has(day)),
      lastTotal: vi.fn(async () => {
        const last = [...days.keys()].sort().at(-1);
        return last ? days.get(last)!.skimmers.length : null;
      }),
      save: vi.fn(async (d: SkimmerDay) => {
        if (!days.has(d.day)) days.set(d.day, d);
      }),
      refuse: vi.fn(async (r: SkimmerRefusal) => {
        refusals.push(r);
      }),
      refusals: vi.fn(
        async (day: string, short: boolean) =>
          refusals.filter((r) => r.day === day && r.reason.startsWith("RBN skimmer list refused: under ") === short).length,
      ),
      lastShortTotal: vi.fn(async (day: string) => {
        const short = refusals.filter((r) => r.day === day && r.reason.startsWith("RBN skimmer list refused: under "));
        return short.at(-1)?.total ?? null;
      }),
    };
    let reply: () => Promise<Response> = async () => new Response(PAGE);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply());
    const run = () => saveSkimmerDay({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, store });
    return {
      run,
      days,
      refusals,
      store,
      fetchImpl,
      clock,
      nextDay: () => (clock += 24 * 60 * 60_000),
      serve: (r: () => Promise<Response>) => (reply = r),
    };
  }

  // Value: protects=the cron saves today's UTC list once, with the fetch time, the parsed skimmers and the exact page gzipped, and a second run the same day fetches nothing; fails_when=the day key isn't the UTC date of the fetch, the raw page isn't the bytes RBN served, the second run refetches or overwrites, or the fetch drops its redirect guard or timeout; why_new=#61 D14 (D3, D4, D5); seam=fetch, store; no_claim=Postgres's upsert
  it("saves today's list once, with the page it came from", async () => {
    const { run, days, fetchImpl, clock } = setupSkimmers();
    expect(await run()).toEqual({ status: "saved", day: "2026-11-20", total: RBN_MIN_SKIMMERS });
    expect(fetchImpl.mock.calls[0]![0]).toBe(RBN_SKIMMERS_URL);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
    const saved = days.get("2026-11-20")!;
    expect(saved.fetchedAt).toBe(clock);
    expect(saved.skimmers[0]).toEqual({ call: "S0X", grid: "JO22AB", bands: ["20m"], lastSeen: clock - 30_000 });
    expect(gunzipSync(saved.raw).toString("utf8")).toBe(PAGE);
    expect(await run()).toEqual({ status: "kept", day: "2026-11-20" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Value: protects=an RBN error, a broken page or an oversized body throws with nothing saved, so the day stays open and the next run (13:30 UTC) can still save it; fails_when=a failed run marks the day saved, or saves a partial or error page; why_new=#61 D14 (D4 retry run); seam=fetch, store; no_claim=RBN's uptime
  it("saves nothing when the fetch or page fails, so a later run can", async () => {
    const { run, days, serve } = setupSkimmers();
    serve(async () => new Response("down", { status: 503 }));
    await expect(run()).rejects.toThrow(/HTTP 503/);
    serve(async () => new Response("<html>maintenance</html>"));
    await expect(run()).rejects.toThrow(/usable grid/);
    serve(async () => new Response(Buffer.alloc(2_000_001, 0x20)));
    await expect(run()).rejects.toThrow(/larger than expected/);
    expect(days.size).toBe(0);
    serve(async () => new Response(PAGE));
    expect(await run()).toMatchObject({ status: "saved" });
  });

  // Value: protects=a list under 80% of the last saved day's (a page cut off partway) is refused instead of becoming the day's permanent list, and the refused page is kept gzipped with its reason so the day can be parsed again later; an HTTP failure keeps nothing (there's no page); the day stays open for the next run; fails_when=a truncated page is saved, the refused page is dropped, or keeping it marks the day done; why_new=/ship Step 11 Codex adversarial and native findings (owner D3, D4); seam=fetch, store; no_claim=Postgres writes
  it("refuses a list cut short against the last saved day, and keeps every refused page", async () => {
    const { run, days, refusals, serve } = setupSkimmers();
    const page = (n: number) => Array.from({ length: n }, (_, i) => row(`B${i}X`)).join("\n");
    days.set("2026-11-19", { day: "2026-11-19", fetchedAt: 0, skimmers: Array(200).fill(null), raw: new Uint8Array() });
    serve(async () => new Response(PAGE)); // 100 skimmers: under 80% of 200
    await expect(run()).rejects.toThrow(/under 80% of the last saved day's 200 skimmers \(100\)/);
    expect(days.has("2026-11-20")).toBe(false);
    expect(refusals[0]).toMatchObject({ day: "2026-11-20", total: 100 });
    expect(gunzipSync(refusals[0]!.raw).toString("utf8")).toBe(PAGE);
    // A second refusal the same day is kept beside the first, not over it.
    serve(async () => new Response("<html>maintenance</html>"));
    await expect(run()).rejects.toThrow(/usable grid/);
    expect(refusals.map((r) => [r.total, gunzipSync(r.raw).toString("utf8").slice(0, 6)])).toEqual([
      [100, PAGE.slice(0, 6)],
      [null, "<html>"],
    ]);
    serve(async () => new Response("down", { status: 503 }));
    await expect(run()).rejects.toThrow(/HTTP 503/);
    expect(refusals).toHaveLength(2); // no page, nothing to keep
    serve(async () => new Response(page(200)));
    expect(await run()).toEqual({ status: "saved", day: "2026-11-20", total: 200 });
  });

  // Value: protects=a real, lasting drop in RBN's list is taken on the second day it agrees (within 10% of the day before's refused count), so one drop can't refuse every day after it, while a day whose refused neighbour disagrees is still refused as a cut-off page; fails_when=a refused day never lets the bar fall (permanent lockout), or any shrink is accepted at once; why_new=/ship pass 2 specialist + Red Team, owner D7; seam=fetch, store; no_claim=how fast RBN's real list moves
  it("takes a real drop once the day before agrees", async () => {
    const { run, days, nextDay, serve } = setupSkimmers();
    const page = (n: number) => Array.from({ length: n }, (_, i) => row(`D${i}X`)).join("\n");
    days.set("2026-11-19", { day: "2026-11-19", fetchedAt: 0, skimmers: Array(300).fill(null), raw: new Uint8Array() });
    serve(async () => new Response(page(200)));
    await expect(run()).rejects.toThrow(/under 80%/); // day 1 of the drop: could be a cut-off page
    nextDay();
    serve(async () => new Response(page(150)));
    await expect(run()).rejects.toThrow(/under 80%/); // 150 vs 200 the day before: disagrees by more than 10%
    nextDay();
    serve(async () => new Response(page(140)));
    expect(await run()).toEqual({ status: "saved", day: "2026-11-22", total: 140 }); // 140 vs 150: agrees
  });

  // Value: protects=the day before's 80%-rule refusal stops counting once a later run saved that day, so a short list today is judged against that saved list as a cut; fails_when=two similar row-boundary cuts on consecutive days let a cut list through because the earlier one was later superseded by a save; why_new=skimmer-snapshot /ship review note (1), TODOS "Tighten the RBN skimmer snapshot edges"; seam=fetch, store; no_claim=how often RBN serves cut pages
  it("ignores the day before's refusal once a later run saved that day", async () => {
    const { run, days, nextDay, serve } = setupSkimmers();
    const page = (n: number) => Array.from({ length: n }, (_, i) => row(`E${i}X`)).join("\n");
    days.set("2026-11-19", { day: "2026-11-19", fetchedAt: 0, skimmers: Array(300).fill(null), raw: new Uint8Array() });
    serve(async () => new Response(page(200)));
    await expect(run()).rejects.toThrow(/under 80%/); // 01:30: a cut page
    serve(async () => new Response(page(300)));
    expect(await run()).toMatchObject({ status: "saved", total: 300 }); // 13:30: the whole list
    nextDay();
    serve(async () => new Response(page(205)));
    await expect(run()).rejects.toThrow(/under 80% of the last saved day's 300/); // agrees with 200, but that day was saved
  });

  // Value: protects=two cron runs at once, where the other saved the day first (Prisma P2002), report "kept" and store no false "Not saved" refusal; fails_when=a lost race is filed as a refused page or answered 502; why_new=skimmer-snapshot /ship review note (4); seam=fetch, store; no_claim=whether Prisma issues a native ON CONFLICT upsert
  it("reports a day another run saved first as kept", async () => {
    const { run, store, refusals } = setupSkimmers();
    store.save.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed on the fields: (`day`)"), { code: "P2002" }));
    expect(await run()).toEqual({ status: "kept", day: "2026-11-20" });
    expect(refusals).toHaveLength(0);
  });

  // Value: protects=at most SKIMMERS_MAX_REFUSALS pages are kept per day, and the run still reports the page's own reason; fails_when=a caller holding CRON_SECRET (or a stuck retry loop) can grow the refusal table without bound, or the cap turns into a thrown error; why_new=skimmer-snapshot /ship review note (6); seam=fetch, store; no_claim=Postgres's count
  it("keeps at most a few refused pages a day", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { run, refusals, serve } = setupSkimmers();
    serve(async () => new Response("<html>maintenance</html>"));
    for (let i = 0; i < SKIMMERS_MAX_REFUSALS + 2; i++) await expect(run()).rejects.toThrow(/usable grid/);
    expect(refusals).toHaveLength(SKIMMERS_MAX_REFUSALS);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/pages already kept for 2026-11-20/));
  });

  // Value: protects=80%-rule refusals and the rest are capped apart: a day full of other refusals still keeps a short list for the next day's agreement check, short lists stop at SKIMMERS_MAX_SHORT_REFUSALS, and short lists never use up the room a "Not saved" page (a good list whose save failed) needs; fails_when=one kind's flood drops the other kind's page, or short-list rows grow without bound for a caller holding CRON_SECRET; why_new=Step 9 Red Team (owner D2) and Step 11 Codex/adversarial findings (owner D3, 2026-11-21); seam=fetch, store; no_claim=atomic caps under parallel calls (a burst can overshoot once)
  it("caps short-list refusals apart from the rest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { run, days, refusals, nextDay, serve, store } = setupSkimmers();
    const page = (n: number) => Array.from({ length: n }, (_, i) => row(`F${i}X`)).join("\n");
    days.set("2026-11-19", { day: "2026-11-19", fetchedAt: 0, skimmers: Array(300).fill(null), raw: new Uint8Array() });
    serve(async () => new Response("<html>maintenance</html>"));
    for (let i = 0; i < SKIMMERS_MAX_REFUSALS; i++) await expect(run()).rejects.toThrow(/usable grid/);
    serve(async () => new Response(page(200)));
    for (let i = 0; i < SKIMMERS_MAX_SHORT_REFUSALS + 2; i++) await expect(run()).rejects.toThrow(/under 80%/);
    expect(refusals).toHaveLength(SKIMMERS_MAX_REFUSALS + SKIMMERS_MAX_SHORT_REFUSALS);
    nextDay();
    // Short lists first, then a good list whose save fails: its page is still kept.
    serve(async () => new Response(page(150)));
    for (let i = 0; i < SKIMMERS_MAX_SHORT_REFUSALS; i++) await expect(run()).rejects.toThrow(/under 80%/);
    serve(async () => new Response(page(300)));
    store.save.mockRejectedValueOnce(new Error("write failed"));
    await expect(run()).rejects.toThrow(/write failed/);
    expect(refusals.at(-1)).toMatchObject({ day: "2026-11-21", reason: "Not saved: write failed", total: 300 });
    // The day before's kept short list still lets a lasting drop through.
    nextDay();
    serve(async () => new Response(page(145)));
    expect(await run()).toEqual({ status: "saved", day: "2026-11-22", total: 145 }); // agrees with 2026-11-21's 150
  });

  // Value: protects=a database error reading the last total or the day before's refusal is reported as itself and not stored as a page refusal, a good page whose save fails is still kept (if the database takes it), and a failure keeping a refused page still reports the page's own reason; fails_when=an outage is filed as a refusal, a parsed page is dropped on a failed save, or the 502 reason becomes the store's error; why_new=/ship pass 2 Red Team + specialist, owner D7; seam=fetch, store; no_claim=Prisma's error types
  it("keeps database failures apart from page refusals", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let s = setupSkimmers();
    s.store.lastTotal.mockRejectedValueOnce(new Error("db down"));
    await expect(s.run()).rejects.toThrow(/db down/);
    expect(s.store.refuse).not.toHaveBeenCalled();
    // Reading the day before's refusal fails: also an outage, never filed as this page's refusal.
    s = setupSkimmers();
    s.days.set("2026-11-18", { day: "2026-11-18", fetchedAt: 0, skimmers: [], raw: new Uint8Array() });
    s.store.lastShortTotal.mockRejectedValueOnce(new Error("db down"));
    await expect(s.run()).rejects.toThrow(/db down/);
    expect(s.store.refuse).not.toHaveBeenCalled();
    s = setupSkimmers();
    s.store.save.mockRejectedValueOnce(new Error("write failed"));
    await expect(s.run()).rejects.toThrow(/write failed/);
    expect(s.refusals[0]).toMatchObject({ reason: "Not saved: write failed", total: RBN_MIN_SKIMMERS });
    s = setupSkimmers();
    s.store.refuse.mockRejectedValueOnce(new Error("db down"));
    s.serve(async () => new Response("<html>maintenance</html>"));
    await expect(s.run()).rejects.toThrow(/usable grid/);
    expect(warn).toHaveBeenCalledWith("cron.rbn-skimmers: couldn't keep the page:", expect.any(Error));
  });
});
