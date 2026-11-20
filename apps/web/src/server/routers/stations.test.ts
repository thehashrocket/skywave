import { describe, expect, it, vi } from "vitest";

// The real module opens a Prisma client at import; this router never uses it.
vi.mock("@/server/db", () => ({ db: {} }));

const { forPageSchedule, scheduleSource, siteSource } = await import("./stations");
const { MIN_SITES } = await import("@/lib/eibi-sites");

const HEADER = "kHz:75;Time(UTC):93;Days:59;ITU:49;Station:201;Lng:49;Target:62;Remarks:135;P:35;Start:60;Stop:60;";
const file = (station: string) => `${HEADER}\r\n9580;0000-2400;;KOR;${station};E;FE;k;1;;\r\n`;
const HOUR = 60 * 60_000;
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(start = Date.parse("2026-11-10T12:00:00Z")) {
  let clock = start;
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(file("Fetched")));
  const defer = vi.fn((_task: Promise<unknown>) => {});
  const get = scheduleSource({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock,
    defer,
    bundled: { season: "b26", csv: file("Bundled") },
  });
  const names = async () => (await get()).broadcasts.map((b) => b.station);
  return { get, names, fetchImpl, defer, advance: (ms: number) => (clock += ms) };
}

describe("scheduleSource", () => {
  // Value: protects=the season's file is fetched from EiBi's season URL without following redirects, decoded as Latin-1, and served from cache for a day; fails_when=the wrong season is asked for, accented names come out garbled, or every page load refetches; why_new=owner decision: fetch and cache; seam=fetch; no_claim=eibispace.de's availability
  it("fetches this season's file once a day", async () => {
    const { get, fetchImpl, advance } = setup();
    fetchImpl.mockImplementationOnce(async () => new Response(Buffer.from(file("Rádio Nacional"), "latin1")));
    const first = await get();
    expect(first).toMatchObject({ season: "b26", bundled: false });
    expect(first.broadcasts[0]!.station).toBe("Rádio Nacional");
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://www.eibispace.de/dx/sked-b26.csv");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    advance(23 * HOUR);
    await get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Value: protects=with nothing fetched, a failed or wrong fetch serves the bundled copy marked as such, and the next try waits ten minutes; fails_when=names vanish (or the query errors) while eibispace.de is down, or a down site is hit on every page load; why_new=owner decision: bundled fallback; seam=fetch; no_claim=the bundled copy is this season's
  it.each([
    ["the site is down", () => Promise.reject(new TypeError("fetch failed"))],
    ["it answers with an error", async () => new Response("oops", { status: 404 })],
    ["the file isn't the schedule", async () => new Response("<html>moved</html>")],
  ])("serves the bundled copy when %s", async (_, failure) => {
    const { get, names, fetchImpl, advance } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchImpl.mockImplementation(failure);
    expect(await get()).toMatchObject({ bundled: true, season: "b26" });
    expect(await names()).toEqual(["Bundled"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    advance(10 * 60_000);
    fetchImpl.mockImplementation(async () => new Response(file("Fetched")));
    expect(await names()).toEqual(["Fetched"]);
  });

  // Value: protects=after a day the cached copy is served at once while a refresh runs through defer, and a failed refresh keeps it; fails_when=a page waits on eibispace.de, or a failed refresh drops the names; why_new=station names; seam=fetch, defer; no_claim=none
  it("refreshes in the background and keeps its copy through a failure", async () => {
    const { names, fetchImpl, defer, advance } = setup();
    await names();
    advance(25 * HOUR);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchImpl.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await names()).toEqual(["Fetched"]);
    expect(defer).toHaveBeenCalledTimes(1);
    await settled();
    fetchImpl.mockImplementationOnce(async () => new Response(file("Newer")));
    expect(await names()).toEqual(["Fetched"]); // backing off: no new request yet
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    advance(10 * 60_000);
    await names();
    await settled();
    expect(await names()).toEqual(["Newer"]);
  });

  // Value: protects=a new season counts as expired even within the day, so the switch in late October or March fetches the new file; fails_when=the old season's schedule is served for up to a day after the switch; why_new=station names; seam=fetch; no_claim=none
  it("fetches the new season's file at the switch", async () => {
    const { get, fetchImpl, advance } = setup(Date.parse("2027-03-27T23:00:00Z"));
    await get();
    advance(2 * HOUR);
    await get();
    await settled();
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      "http://www.eibispace.de/dx/sked-b26.csv",
      "http://www.eibispace.de/dx/sked-a27.csv",
    ]);
    expect((await get()).season).toBe("a27");
  });
});

describe("stations.schedule for the page (#72)", () => {
  // Value: protects=the page gets the schedule exactly as before #72: plain broadcasts with no country, site or listed rows, while the server keeps them; fails_when=site data leaks into the page payload or the server loses it; why_new=#72 D7/D13; seam=fetch; no_claim=compressed transfer size
  it("keeps sites on the server", async () => {
    const { get } = setup();
    const schedule = await get();
    expect(schedule.listed[0]).toMatchObject({ station: "Fetched", country: "KOR", site: "KOR-k" });
    const page = forPageSchedule(schedule);
    expect(Object.keys(page).sort()).toEqual(["broadcasts", "bundled", "season"]);
    expect(page.broadcasts[0]).toEqual({
      khz: 9580,
      start: 0,
      end: 1440,
      days: "",
      station: "Fetched",
      lang: "E",
      target: "FE",
    });
  });
});

/** A README with `n` sites, KOR-k placed at `lat`. */
const readmeFile = (lat: number, n = MIN_SITES) =>
  [
    "   IV) Transmitter site codes.",
    `   KOR: k-Kimjae ${lat}N00-126E50`,
    // Three-character codes, so up to 46,656 fillers stay distinct site codes.
    ...Array.from({ length: n - 1 }, (_, i) => `        ${i.toString(36).padStart(3, "0")}-Filler 10N00-010E00`),
  ].join("\r\n");

describe("siteSource", () => {
  function sites(start = Date.parse("2026-11-10T12:00:00Z")) {
    let clock = start;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(readmeFile(35)));
    const defer = vi.fn((_task: Promise<unknown>) => {});
    const get = siteSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
      defer,
      bundled: () => new Map([["KOR-k", { country: "KOR", coords: [[1, 1]] }]]),
    });
    const kimjae = () => get().get("KOR-k")!.coords[0]![0];
    return { get, kimjae, fetchImpl, defer, advance: (ms: number) => (clock += ms) };
  }

  // Value: protects=an answer never waits on eibispace.de: the first lookup answers from the bundled table and starts one background fetch of EiBi's README (no redirects), shared by answers while it runs, whose table later lookups use for a day; fails_when=submit awaits the README, the bundled table is ignored, answers during a download start more fetches, or every answer refetches; why_new=#72 D9; seam=fetch, defer; no_claim=eibispace.de's availability
  it("answers from the bundled table and refreshes in the background", async () => {
    const { kimjae, fetchImpl, defer, advance } = sites();
    expect(kimjae()).toBe(1);
    expect(defer).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://www.eibispace.de/dx/README.TXT");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    // Answers while the README is still downloading share that one fetch.
    expect(kimjae()).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(defer).toHaveBeenCalledTimes(1);
    await settled();
    expect(kimjae()).toBe(35);
    advance(23 * HOUR);
    kimjae();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    advance(2 * HOUR);
    fetchImpl.mockImplementationOnce(async () => new Response(readmeFile(36)));
    expect(kimjae()).toBe(35); // still the old table while the refresh runs
    await settled();
    expect(kimjae()).toBe(36);
  });

  // Value: protects=a README that fails, errors or is cut short keeps the last good table and is asked for again only after ten minutes; fails_when=a broken file empties the sites, or a down site is hit on every answer; why_new=#72 D6/D11; seam=fetch, defer; no_claim=none
  it.each([
    ["the site is down", () => Promise.reject(new TypeError("fetch failed"))],
    ["it answers with an error", async () => new Response("oops", { status: 404 })],
    ["the file is cut short", async () => new Response(readmeFile(40, 300))],
  ])("keeps the last good table when %s", async (_, failure) => {
    const { kimjae, fetchImpl, advance } = sites();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    kimjae();
    await settled();
    advance(25 * HOUR);
    fetchImpl.mockImplementation(failure);
    kimjae();
    await settled();
    expect(kimjae()).toBe(35);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    advance(9 * 60_000);
    kimjae();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    advance(60_000);
    fetchImpl.mockImplementation(async () => new Response(readmeFile(37)));
    kimjae();
    await settled();
    expect(kimjae()).toBe(37);
  });

  // Value: protects=a refused README is logged with its own site count and the last good table's, and that table is the one checked against; fails_when=a refusal is silent or omits the counts; why_new=owner rule before /ship (#72); seam=fetch, defer, console.warn; no_claim=none beyond protects
  it("logs both counts when it refuses a README", async () => {
    const { kimjae, fetchImpl, advance } = sites();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    kimjae();
    await settled();
    advance(25 * HOUR);
    fetchImpl.mockImplementation(async () => new Response(readmeFile(40, 500)));
    kimjae();
    await settled();
    expect(kimjae()).toBe(35);
    expect(String(warn.mock.calls.at(-1)![1])).toMatch(
      /500 transmitter sites, under 80% of the largest good table's 1000/,
    );
  });

  // Value: protects=the refusal bar is the largest table this server has accepted, so a run of slightly short READMEs can't step it down (2,500 accepted, then 2,000, then 1,600 refused though it is 80% of 2,000); fails_when=a new README is compared with the current table only (or the larger of bundled and current); why_new=#72 follow-up, outside voice OV4 (owner D6); seam=fetch, defer, console.warn; no_claim=a real permanent shrink in EiBi's list (refused until the next deploy, by choice)
  it("never lets the refusal bar step down", async () => {
    const { kimjae, fetchImpl, advance } = sites();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refreshWith = async (lat: number, n: number) => {
      fetchImpl.mockImplementation(async () => new Response(readmeFile(lat, n)));
      advance(25 * HOUR);
      kimjae();
      await settled();
    };
    kimjae(); // starts the first refresh (1,000 sites)
    await settled();
    await refreshWith(36, 2_500);
    expect(kimjae()).toBe(36);
    await refreshWith(37, 2_000);
    expect(kimjae()).toBe(37);
    await refreshWith(38, 1_600);
    expect(kimjae()).toBe(37);
    expect(String(warn.mock.calls.at(-1)![1])).toMatch(/1600 transmitter sites, under 80% of the largest good table's 2500/);
  });

  // Value: protects=the page's schedule request never fetches the README, so a slow eibispace.de README can't delay a page load; fails_when=the README fetch moves onto the schedule path; why_new=#72 D9; seam=fetch; no_claim=none
  it("isn't fetched with the schedule", async () => {
    const { get, fetchImpl } = setup();
    await get();
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(["http://www.eibispace.de/dx/sked-b26.csv"]);
  });
});
