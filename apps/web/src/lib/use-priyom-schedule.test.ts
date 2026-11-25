import { describe, expect, it } from "vitest";
import type { PriyomTx } from "./priyom-schedule";
import { scheduleState } from "./use-priyom-schedule";

describe("scheduleState", () => {
  // Value: protects=a station page (#103) tells "still loading" (undefined: say nothing yet) apart from "no schedule" (null: say unavailable, check Priyom), and a failed request counts as no schedule rather than loading forever; fails_when=loading maps to null (false "unavailable" on every cold load), or a failed request maps to undefined (page silent ~15 min during an outage); why_new=#103 Codex and final-review findings; the SignalLive test mocks the hook, so nothing else pins this mapping; seam=none (pure function); no_claim=react-query's own state transitions
  it("keeps loading, no schedule and a failed request apart", () => {
    const tx: PriyomTx[] = [{ station: "E11", startMs: 0, khz: 8_102, mode: "usb", summary: "E11" }];
    expect(scheduleState(undefined, false)).toBeUndefined();
    expect(scheduleState(undefined, true)).toBeNull();
    expect(scheduleState({ transmissions: null }, false)).toBeNull();
    expect(scheduleState({ transmissions: tx }, false)).toBe(tx);
    expect(scheduleState({ transmissions: tx }, true)).toBe(tx);
  });
});
