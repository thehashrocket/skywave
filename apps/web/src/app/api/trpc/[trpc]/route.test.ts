import { describe, expect, it, vi } from "vitest";
import { REMEASURE_PATH, SERVER_MS_HEADER, measureFromResponse } from "@/lib/server-clock";

vi.mock("@/server/db", () => ({ db: {} }));

const { GET, POST } = await import("./route");

describe("the tRPC route's server time", () => {
  // Value: protects=every tRPC reply, the clock's HEAD and an error alike, carries the server's time in ms, fresh, so the page measures to half the round trip instead of the Date header's whole seconds; fails_when=the route stops stamping, stamps only successes, or the HEAD path stops reaching tRPC; why_new=ms precision (owner, scheduled-clock round); seam=db mocked, route handler called directly; no_claim=what Vercel's edge adds (HEAD on production gave 204 with age 0, x-vercel-cache MISS)
  it("stamps the clock's HEAD and an error reply with the time", async () => {
    const before = Date.now();
    // Next answers HEAD with the GET export.
    const head = await GET(new Request(`http://skywave.test${REMEASURE_PATH}`, { method: "HEAD" }));
    const missing = await POST(new Request("http://skywave.test/api/trpc/nope", { method: "POST", body: "{}" }));
    const after = Date.now();
    expect(head.status).toBe(204);
    expect(missing.ok).toBe(false);
    for (const res of [head, missing]) {
      const stamped = Number(res.headers.get(SERVER_MS_HEADER));
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(after);
      expect(measureFromResponse(res.headers, before, after)!.error).toBe((after - before) / 2);
    }
  });
});
