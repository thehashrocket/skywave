// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sunPosition } from "./solar";

const at = (iso: string) => ({ ...sunPosition(Date.parse(iso)), at: Date.parse(iso) });
import { useSolarClock } from "./use-solar-clock";

// The server-corrected clock (#148 D14): this device's clock plus `skew.ms`, and the
// listeners told when the correction changes.
const skew = vi.hoisted(() => ({ ms: 0, listeners: new Set<() => void>() }));
vi.mock("./server-clock", () => ({
  serverNow: () => Date.now() + skew.ms,
  onServerOffset: (l: () => void) => {
    skew.listeners.add(l);
    return () => skew.listeners.delete(l);
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-20T12:00:40Z"));
});
afterEach(() => {
  vi.useRealTimers();
  skew.ms = 0;
});

// Value: protects=Night badges and the greyline move with the clock and stop when unmounted; fails_when=the clock never ticks, drifts off the minute, or leaks its timer; why_new=O6 page-level clock; seam=fake timers; no_claim=sun accuracy (solar.test)
it("gives the sun now and again on each minute boundary", () => {
  const { result, unmount } = renderHook(() => useSolarClock());
  expect(result.current).toEqual(at("2026-10-20T12:00:40Z"));

  act(() => vi.advanceTimersByTime(19_999));
  expect(result.current).toEqual(at("2026-10-20T12:00:40Z"));
  act(() => vi.advanceTimersByTime(1));
  expect(result.current).toEqual(at("2026-10-20T12:01:00Z"));
  act(() => vi.advanceTimersByTime(60_000));
  expect(result.current).toEqual(at("2026-10-20T12:02:00Z"));

  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

// Value: protects=the page's one clock is the server-corrected one (#148 D14): on a device 40 s slow it reads the corrected time, ticks on the corrected minute (so station names flip at a slot's start, as the panel does), and re-reads at once when the correction is first measured; fails_when=the clock goes back to Date.now, ticks on the device's minute, or ignores a new correction until the next minute; why_new=D14; seam=server-clock mocked, fake timers; no_claim=how the correction is measured (server-clock.test)
it("follows the server-corrected clock and its minute", () => {
  const { result, unmount } = renderHook(() => useSolarClock());
  expect(result.current).toEqual(at("2026-10-20T12:00:40Z"));
  // The correction arrives: this device is 40 s slow.
  skew.ms = 40_000;
  act(() => skew.listeners.forEach((l) => l()));
  expect(result.current).toEqual(at("2026-10-20T12:01:20Z"));
  // The next tick is the corrected 12:02:00, 40 s later, not the device's 12:01:00.
  act(() => vi.advanceTimersByTime(39_999));
  expect(result.current).toEqual(at("2026-10-20T12:01:20Z"));
  act(() => vi.advanceTimersByTime(1));
  expect(result.current).toEqual(at("2026-10-20T12:02:00Z"));
  unmount();
  expect(skew.listeners.size).toBe(0);
});
