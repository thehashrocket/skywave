// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sunPosition } from "./solar";
import { useSolarClock } from "./use-solar-clock";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-20T12:00:40Z"));
});
afterEach(() => vi.useRealTimers());

// Value: protects=Night badges and the greyline move with the clock and stop when unmounted; fails_when=the clock never ticks, drifts off the minute, or leaks its timer; why_new=O6 page-level clock; seam=fake timers; no_claim=sun accuracy (solar.test)
it("gives the sun now and again on each minute boundary", () => {
  const { result, unmount } = renderHook(() => useSolarClock());
  expect(result.current).toEqual(sunPosition(Date.parse("2026-10-20T12:00:40Z")));

  act(() => vi.advanceTimersByTime(19_999));
  expect(result.current).toEqual(sunPosition(Date.parse("2026-10-20T12:00:40Z")));
  act(() => vi.advanceTimersByTime(1));
  expect(result.current).toEqual(sunPosition(Date.parse("2026-10-20T12:01:00Z")));
  act(() => vi.advanceTimersByTime(60_000));
  expect(result.current).toEqual(sunPosition(Date.parse("2026-10-20T12:02:00Z")));

  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
