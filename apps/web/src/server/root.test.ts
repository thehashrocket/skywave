import { afterEach, describe, expect, it, vi } from "vitest";

// The real module opens a Prisma client at import; these routers never use it.
vi.mock("@/server/db", () => ({ db: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("appRouter", () => {
  // Value: protects=the app's router serves the schedule, and with eibispace.de down on a fresh server it answers with the bundled copy rather than an error, without the server-only listing, country or site (#72 D7); fails_when=the router isn't registered, a down site breaks the query, or the query returns getSchedule() unstripped; why_new=owner decision: bundled fallback; seam=global fetch stubbed; no_claim=none
  it("is served by the app's router, bundled when the site is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { appRouter } = await import("./root");
    const result = await appRouter.createCaller({ db: {} } as never).stations.schedule();
    expect(result.bundled).toBe(true);
    expect(result.broadcasts.length).toBeGreaterThan(5_000);
    // #72 D7: the query itself strips the server-only listing, so no country or site reaches the page.
    expect(result).not.toHaveProperty("listed");
    expect(result.broadcasts.some((b) => "country" in b || "site" in b)).toBe(false);
  });
});
