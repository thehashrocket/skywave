import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "./proxy";

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;

const request = (path: string, authorization?: string) =>
  new NextRequest(`http://localhost${path}`, { headers: authorization ? { authorization } : {} });

const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy", () => {
  it("lets everything through when APP_PASSWORD is unset", async () => {
    vi.stubEnv("APP_PASSWORD", "");
    expect(passedThrough(await proxy(request("/api/trpc/presets.delete")))).toBe(true);
  });

  // Value: protects=Vercel's cron, which sends its own bearer secret and never the site password, still reaches /api/cron/ routes on a password-locked Production (each route checks CRON_SECRET itself), while every other path, including look-alikes, still asks for the password; fails_when=the gate 401s the cron (skimmer days lost for good) or the exemption leaks to other paths such as /api/cronx or /api/trpc; why_new=#61 skimmer snapshots, owner decision D1 in /ship; seam=none; no_claim=the cron route's own secret check (route.test.ts)
  it("lets Vercel's cron reach /api/cron/ routes, and nothing else, past the password", async () => {
    vi.stubEnv("APP_PASSWORD", "hunter2");
    expect(passedThrough(await proxy(request("/api/cron/rbn-skimmers", "Bearer cron-secret")))).toBe(true);
    for (const path of ["/api/cron", "/api/cronx/rbn-skimmers", "/api/trpc/cron", "/x/api/cron/rbn-skimmers"])
      expect((await proxy(request(path, "Bearer cron-secret"))).status).toBe(401);
  });

  // Value: protects=#147 the weekly GitHub Action, which brings its own bearer secret, reaches /api/signals/freshness on a password-locked Production (the route checks SIGNAL_FRESHNESS_SECRET itself), and only that exact path; fails_when=the gate 401s the Action (no report, the issue goes stale) or the exemption leaks to look-alikes; why_new=#147 route; seam=none; no_claim=the route's own secret check (route.test.ts)
  it("lets the freshness Action reach its route, and nothing else, past the password", async () => {
    vi.stubEnv("APP_PASSWORD", "hunter2");
    expect(passedThrough(await proxy(request("/api/signals/freshness", "Bearer s")))).toBe(true);
    for (const path of ["/api/signals/freshness/x", "/api/signals/freshnessx", "/api/signals", "/signals/freshness"])
      expect((await proxy(request(path, "Bearer s"))).status).toBe(401);
  });

  it.each(["/", "/api/trpc/presets.delete", "/_next/static/chunks/app.js", "/worklets/radio-player.js"])(
    "asks for the password on %s",
    async (path) => {
      vi.stubEnv("APP_PASSWORD", "hunter2");
      const res = await proxy(request(path));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic realm="skywave"/);
    },
  );

  it.each([
    ["the right password, any username", basic("whoever", "hunter2"), true],
    ["a wrong password", basic("whoever", "hunter3"), false],
    ["a password that only shares a prefix", basic("whoever", "hunter"), false],
    ["a non-Basic scheme", "Bearer hunter2", false],
    ["undecodable base64", "Basic !!!", false],
    ["credentials without a colon", `Basic ${Buffer.from("hunter2").toString("base64")}`, false],
  ])("handles %s", async (_, authorization, ok) => {
    vi.stubEnv("APP_PASSWORD", "hunter2");
    const res = await proxy(request("/", authorization));
    expect(passedThrough(res)).toBe(ok);
    expect(res.status).toBe(ok ? 200 : 401);
  });

  it("accepts non-ASCII passwords", async () => {
    vi.stubEnv("APP_PASSWORD", "pässwörd");
    expect(passedThrough(await proxy(request("/", basic("me", "pässwörd"))))).toBe(true);
  });
});
