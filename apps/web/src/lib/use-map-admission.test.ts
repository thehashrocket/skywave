// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_ADMIT_MS, IDLE_FALLBACK_MS, useMapAdmission } from "./use-map-admission";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(initial: { heardAudio: boolean; busy: boolean }) {
  return renderHook((props) => useMapAdmission(props), { initialProps: initial });
}

describe("useMapAdmission", () => {
  // Value: protects=no map request starts in the gap between "listening" and the first audio frame; fails_when=the gate reads status "listening" instead of heard audio; why_new=R7; seam=props for use-radio's flags, fake timers; no_claim=how use-radio sets heardAudio (its own tests)
  it("waits for the first audio frame while the radio is busy", () => {
    const { result, rerender } = setup({ heardAudio: false, busy: true });
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(false);
    rerender({ heardAudio: true, busy: true });
    act(() => vi.advanceTimersByTime(IDLE_FALLBACK_MS));
    expect(result.current).toBe(true);
  });

  // Value: protects=someone who never presses Listen still gets the map; fails_when=the idle path is missing or waits the wrong time; why_new=R7 (5 s idle); seam=fake timers; no_claim=none beyond protects
  it("loads after 5 s with nothing playing or connecting", () => {
    const { result } = setup({ heardAudio: false, busy: false });
    act(() => vi.advanceTimersByTime(IDLE_ADMIT_MS + IDLE_FALLBACK_MS - 1));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  // Value: protects=pressing Listen at 4.9 s doesn't let the map load mid-connect; fails_when=a tune doesn't cancel the scheduled idle mount; why_new=O2 (Codex High); seam=fake timers; no_claim=none beyond protects
  it("cancels the idle load when a tune starts", () => {
    const { result, rerender } = setup({ heardAudio: false, busy: false });
    act(() => vi.advanceTimersByTime(4_900));
    rerender({ heardAudio: false, busy: true });
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(false);
  });

  // Value: protects=the map loads at an idle moment where the browser offers one; fails_when=requestIdleCallback is ignored or its handle leaks on cancel; why_new=R4; seam=a stubbed requestIdleCallback; no_claim=browser idle timing
  it("uses requestIdleCallback when the browser has it", () => {
    const callbacks: (() => void)[] = [];
    const idle = vi.fn((cb: () => void) => callbacks.push(cb));
    vi.stubGlobal("requestIdleCallback", idle);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const { result } = setup({ heardAudio: true, busy: true });
    expect(result.current).toBe(false);
    expect(callbacks).toHaveLength(1);
    // A page that's always busy still gets the map within 2 s.
    expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 2_000 });
    act(() => callbacks[0]!());
    expect(result.current).toBe(true);
  });

  // Value: protects=a tune starting after the 5 s wait, while the idle callback is still queued, keeps the map from loading mid-connect; fails_when=cleanup stops cancelling the requestIdleCallback handle; why_new=the cancel test runs where requestIdleCallback is missing (setTimeout fallback); seam=a stubbed requestIdleCallback; no_claim=browser idle timing
  it("cancels a queued idle callback when a tune starts", () => {
    const callbacks = new Map<number, () => void>();
    let next = 0;
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => (callbacks.set(++next, cb), next));
    vi.stubGlobal("cancelIdleCallback", (id: number) => callbacks.delete(id));
    const { result, rerender } = setup({ heardAudio: false, busy: false });
    act(() => vi.advanceTimersByTime(IDLE_ADMIT_MS));
    expect(callbacks.size).toBe(1);
    rerender({ heardAudio: false, busy: true });
    act(() => callbacks.forEach((cb) => cb()));
    expect(result.current).toBe(false);
  });

  // Value: protects=once audio has played, a quick Stop or switch before the idle moment doesn't send the map back to the 5 s wait; fails_when=admission follows heardAudio back to false; why_new=Codex structured P2 (PR 2b ship); seam=props, fake timers; no_claim=idle timing
  it("keeps counting audio heard once, until admitted", () => {
    const { result, rerender } = setup({ heardAudio: true, busy: true });
    rerender({ heardAudio: false, busy: true });
    act(() => vi.advanceTimersByTime(IDLE_FALLBACK_MS));
    expect(result.current).toBe(true);
  });

  // Value: protects=switching receivers never unloads the map; fails_when=admission follows the radio back to false; why_new=O4 (adapter kept mounted); seam=none; no_claim=none beyond protects
  it("stays admitted once admitted", () => {
    const { result, rerender } = setup({ heardAudio: true, busy: false });
    act(() => vi.advanceTimersByTime(IDLE_FALLBACK_MS));
    rerender({ heardAudio: false, busy: true });
    expect(result.current).toBe(true);
  });
});
