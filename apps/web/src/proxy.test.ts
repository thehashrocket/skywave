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
