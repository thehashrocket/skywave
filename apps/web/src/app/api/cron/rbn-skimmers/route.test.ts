import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const saveSkimmerDay = vi.fn();
vi.mock("@/server/routers/beacons", () => ({ saveSkimmerDay }));
const { GET } = await import("./route");

const call = (auth?: string) =>
  GET(new Request("https://skywave.test/api/cron/rbn-skimmers", { headers: auth ? { authorization: auth } : {} }));

describe("RBN skimmer cron", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    saveSkimmerDay.mockReset();
    vi.restoreAllMocks();
  });

  // Value: protects=only Vercel's cron (Authorization: Bearer $CRON_SECRET) can make the server fetch RBN's list: a missing or wrong bearer, or any call while CRON_SECRET is unset, gets 401 and fetches nothing; fails_when=an unset secret lets every caller through (Bearer undefined), or the check is skipped; why_new=#61 D14 (D2); seam=saveSkimmerDay mocked; no_claim=Vercel sending the header
  it("refuses any caller without the cron secret", async () => {
    // Unset (Production before the owner adds it) and empty both refuse, even
    // a caller who guesses what an unset secret would interpolate to.
    vi.stubEnv("CRON_SECRET", undefined);
    expect((await call("Bearer undefined")).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer")).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call("s3cret")).status).toBe(401);
    expect(saveSkimmerDay).not.toHaveBeenCalled();
  });

  // Value: protects=an authorized run returns saveSkimmerDay's result as JSON (saved or kept), and a failure returns 502 with the reason for Vercel's cron log instead of a 200 that hides it; fails_when=a failed fetch reports success, or the error escapes as an unhandled 500 without its reason; why_new=#61 D14 (D6 relies on the log and the saved/kept reply); seam=saveSkimmerDay mocked; no_claim=what Vercel does with a 502
  it("reports saved, kept or why it failed", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    saveSkimmerDay.mockResolvedValueOnce({ status: "saved", day: "2026-11-20", total: 350 });
    let res = await call("Bearer s3cret");
    expect([res.status, await res.json()]).toEqual([200, { status: "saved", day: "2026-11-20", total: 350 }]);
    saveSkimmerDay.mockResolvedValueOnce({ status: "kept", day: "2026-11-20" });
    res = await call("Bearer s3cret");
    expect(await res.json()).toEqual({ status: "kept", day: "2026-11-20" });
    saveSkimmerDay.mockRejectedValueOnce(new Error("RBN's skimmer list: HTTP 503"));
    res = await call("Bearer s3cret");
    expect([res.status, await res.json()]).toEqual([502, { status: "failed", reason: "RBN's skimmer list: HTTP 503" }]);
  });

  // Value: protects=Vercel calls this route twice a day (about 01:30 and 13:30 UTC), so a failed morning run is retried the same day; fails_when=vercel.json drops an entry, points at another path, or both runs share one time; why_new=#61 D14 (D2, D4); seam=reads apps/web/vercel.json as text; no_claim=Vercel running it
  it("is scheduled twice a day", () => {
    const config = JSON.parse(readFileSync(new URL("../../../../../vercel.json", import.meta.url), "utf8"));
    expect(config.crons).toEqual([
      { path: "/api/cron/rbn-skimmers", schedule: "30 1 * * *" },
      { path: "/api/cron/rbn-skimmers", schedule: "30 13 * * *" },
    ]);
  });

  // Value: protects=whoever deploys the app finds CRON_SECRET in .env.example with what it's for, since without it in Production every cron run is refused and skimmer days are lost for good; fails_when=the entry is dropped or renamed away from the variable the route reads; why_new=#61 D14 (D2, D6); seam=reads apps/web/.env.example as text; no_claim=the secret being set in Vercel
  it("documents CRON_SECRET in .env.example", () => {
    const example = readFileSync(new URL("../../../../../.env.example", import.meta.url), "utf8");
    expect(example).toMatch(/^CRON_SECRET=$/m);
    expect(example).toContain("src/app/api/cron/rbn-skimmers");
  });
});
