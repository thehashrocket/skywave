// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOT_MS } from "./ibp";
import { noteResponse, resetServerClock } from "./server-clock";
import { useServerTick } from "./use-server-tick";

const NOON = Date.UTC(2026, 10, 18, 12);

describe("useServerTick", () => {
  beforeEach(() => {
    resetServerClock();
    vi.useFakeTimers({ now: NOON + 3_000 });
  });
  afterEach(() => vi.useRealTimers());

  // Value: protects=the map's beacons change exactly on each 10 s boundary, not drifting with render timing; fails_when=the tick isn't floored to the slot, or the next timer is set from the wrong moment; why_new=beacon layer updates every 10 s; seam=fake timers; no_claim=none
  it("ticks on each slot boundary", () => {
    const { result } = renderHook(() => useServerTick(SLOT_MS));
    expect(result.current).toBe(NOON);
    act(() => vi.advanceTimersByTime(6_999));
    expect(result.current).toBe(NOON);
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(NOON + SLOT_MS);
  });

  // Value: protects=a clock found to be skewed is corrected on screen as soon as the server's offset arrives, not a slot later; fails_when=the hook ignores the offset arriving; why_new=server clock (5 s skew); seam=fake timers; no_claim=none
  it("jumps to the server's slot when the offset arrives", () => {
    const { result } = renderHook(() => useServerTick(SLOT_MS));
    expect(result.current).toBe(NOON);
    // The server is 9 s ahead: it's already in the next slot.
    act(() => noteResponse(new Headers({ date: new Date(NOON + 12_000).toUTCString() }), Date.now(), Date.now()));
    expect(result.current).toBe(NOON + SLOT_MS);
  });

  it("is null while disabled", () => {
    const { result, rerender } = renderHook((on: boolean) => useServerTick(SLOT_MS, on), { initialProps: false });
    expect(result.current).toBeNull();
    rerender(true);
    expect(result.current).toBe(NOON);
  });
});
