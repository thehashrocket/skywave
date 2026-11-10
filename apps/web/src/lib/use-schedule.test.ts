import { describe, expect, it } from "vitest";
import { scheduleRefetchMs } from "./use-schedule";

describe("useSchedule", () => {
  // Value: protects=a page holding the server's bundled copy asks again within a quarter hour, so it picks up the fetched schedule once eibispace.de answers, and otherwise only every six hours; fails_when=a page keeps fallback names all day, or polls a 0.5 MB schedule often; why_new=owner decision: bundled fallback; seam=none; no_claim=react-query's own scheduling
  it("asks again soon only while the server has the bundled copy", () => {
    expect(scheduleRefetchMs({ bundled: true })).toBe(15 * 60_000);
    expect(scheduleRefetchMs({ bundled: false })).toBe(6 * 60 * 60_000);
    expect(scheduleRefetchMs(undefined)).toBe(6 * 60 * 60_000);
  });
});
