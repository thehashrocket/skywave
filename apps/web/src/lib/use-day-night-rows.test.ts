import { describe, expect, it } from "vitest";
import { rowsState } from "./use-day-night-rows";

describe("rowsState", () => {
  // Value: protects=#168 a day/night station page holds its Listen only while the rows are really on their way (undefined), and follows the sun (null) when it didn't ask, the request failed, or it can't be sent offline; fails_when=a failed or paused request reads as loading and the page shows nothing for the retries or forever offline (review), or rows that came are dropped; why_new=/ship review of #168; SignalLive.test mocks the hook, so nothing else pins this mapping; seam=none (pure function); no_claim=react-query's own state transitions
  it("keeps loading, none and rows apart", () => {
    const rows = [{ khz: 3_756 }];
    expect(rowsState(true, undefined, false)).toBeUndefined();
    expect(rowsState(true, undefined, true)).toBeNull();
    expect(rowsState(false, undefined, false)).toBeNull();
    expect(rowsState(false, rows, false)).toBeNull();
    expect(rowsState(true, rows, false)).toBe(rows);
    expect(rowsState(true, rows, true)).toBe(rows);
  });
});
