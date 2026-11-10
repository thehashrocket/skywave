// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Receiver } from "./kiwi-list";
import { REST_MS, useBetterReceiver } from "./use-better-receiver";

function rx(host: string, over: Partial<Receiver> = {}): Receiver {
  return {
    id: host,
    name: host.toUpperCase(),
    location: "",
    antenna: "",
    host,
    port: 8073,
    users: 0,
    usersMax: 8,
    snr: 20,
    minKhz: 0,
    maxKhz: 30_000,
    ...over,
  };
}

// "here" tunes up to 10 MHz, so anything above gets an offer of "other".
const receivers = [rx("here", { maxKhz: 10_000 }), rx("other"), rx("third", { snr: 5 })];
const here = { host: "here", port: 8073 };

type Props = { enabled: boolean; freqKhz: number; playing: { host: string; port: number } | null };

function setup(initial: Partial<Props> = {}) {
  return renderHook((p: Props) => useBetterReceiver({ ...p, receivers, isRefused: () => false }), {
    initialProps: { enabled: true, freqKhz: 9_000, playing: here, ...initial },
  });
}

describe("useBetterReceiver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Value: protects=no offer appears while the dial keeps moving (a drag sends a change every few ms), only once it rests, and a move hides one at once so a button never shifts under the pointer; fails_when=the rest timer isn't reset on each move or the offer isn't cleared on a move; why_new=switch prompt; seam=fake timers; no_claim=real pointer timing
  it("waits for the dial to rest, and hides the offer when it moves", () => {
    const hook = setup();
    for (let f = 11_000; f < 11_010; f++) {
      hook.rerender({ enabled: true, freqKhz: f, playing: here });
      act(() => vi.advanceTimersByTime(REST_MS - 1));
    }
    expect(hook.result.current.offer).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current.offer?.target.host).toBe("other");
    hook.rerender({ enabled: true, freqKhz: 12_000, playing: here });
    expect(hook.result.current.offer).toBeNull();
  });

  // Value: protects=Not now keeps that receiver from being offered again from this one, even after leaving and coming back (a failed switch returns here), while another target can still be offered; fails_when=dismissals are forgotten on a receiver change or keyed by target alone; why_new=switch prompt; seam=fake timers; no_claim=none beyond protects
  it("doesn't offer a dismissed receiver again from the same one", () => {
    const hook = setup({ freqKhz: 11_000 });
    act(() => vi.advanceTimersByTime(REST_MS));
    expect(hook.result.current.offer?.target.host).toBe("other");
    act(() => hook.result.current.dismiss());
    expect(hook.result.current.offer).toBeNull();
    // Away (a switch connecting) and back.
    hook.rerender({ enabled: false, freqKhz: 11_000, playing: null });
    hook.rerender({ enabled: true, freqKhz: 11_500, playing: here });
    act(() => vi.advanceTimersByTime(REST_MS));
    expect(hook.result.current.offer?.target.host).toBe("third");
  });

  // Value: protects=nothing is offered while a tune is under way or Pick best is still at work (the page's enabled), nor with nothing playing; fails_when=the hook ignores enabled or playing; why_new=switch prompt; seam=fake timers; no_claim=the page's choice of enabled (page tests)
  it("offers nothing while disabled or with nothing playing", () => {
    const hook = setup({ enabled: false, freqKhz: 11_000 });
    act(() => vi.advanceTimersByTime(REST_MS * 2));
    expect(hook.result.current.offer).toBeNull();
    hook.rerender({ enabled: true, freqKhz: 11_000, playing: null });
    act(() => vi.advanceTimersByTime(REST_MS * 2));
    expect(hook.result.current.offer).toBeNull();
  });
});
