import { describe, expect, it, vi } from "vitest";

// The real module opens a Prisma client at import; this router never uses it.
vi.mock("@/server/db", () => ({ db: {} }));

const { scheduleSource } = await import("./stations");

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
