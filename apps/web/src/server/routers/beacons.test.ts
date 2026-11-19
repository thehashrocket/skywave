import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The real module opens a Prisma client at import; this router never uses it.
vi.mock("@/server/db", () => ({ db: {} }));

const { beaconStatusSource } = await import("./beacons");
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
