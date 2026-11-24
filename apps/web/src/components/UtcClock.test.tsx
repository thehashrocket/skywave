// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The server's time the clock sees: useServerTick rounds down to its step, null before mount.
let serverMs: number | null = Date.parse("2026-11-23T14:05:09.400Z");
vi.mock("@/lib/use-server-tick", () => ({
  useServerTick: (step: number) => (serverMs === null ? null : serverMs - (serverMs % step)),
}));

const { UtcClock } = await import("./UtcClock");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  serverMs = Date.parse("2026-11-23T14:05:09.400Z");
});

const clock = (container: HTMLElement) => container.querySelector("time")!;

describe("UtcClock", () => {
  // Value: protects=the header clock shows the server-corrected UTC weekday, date and 24-hour time, not the device clock; fails_when=it reads Date.now or a local field; why_new=#106; seam=useServerTick mocked; no_claim=the server-clock measurement (server-clock.test.tsx)
  it("shows the server's UTC time in the header form", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-23T09:00:00Z")); // the device is hours off
    const { container } = render(<UtcClock />);
    expect(clock(container).textContent).toBe("Mon 23 Nov 14:05:09 UTC");
    expect(clock(container).getAttribute("dateTime")).toBe("2026-11-23T14:05:09.000Z");
    expect(clock(container).hasAttribute("data-pending")).toBe(false);
  });

  // Value: protects=the bar's clock is HH:MM UTC on a minute step, no seconds (design DD15, re-run D1); fails_when=compact shows seconds or ticks each second; why_new=design DD4; seam=useServerTick mocked; no_claim=placement in the bar (TuningBar test)
  it("shows HH:MM in the compact form", () => {
    const { container } = render(<UtcClock compact />);
    expect(clock(container).textContent).toBe("14:05 UTC");
    expect(clock(container).getAttribute("dateTime")).toBe("2026-11-23T14:05:00.000Z");
  });

  // Value: protects=before mount the clock keeps its space with hidden stand-ins and claims no time (design DD7); fails_when=the placeholder is empty (header shifts on mount) or shows a made-up time; why_new=#106 SSR; seam=useServerTick mocked to null; no_claim=CSS visibility (stylesheet)
  it.each([[false], [true]])("holds its place before mount (compact %s)", (compact) => {
    serverMs = null;
    const { container } = render(<UtcClock compact={compact} />);
    expect(clock(container).hasAttribute("data-pending")).toBe(true);
    expect(clock(container).hasAttribute("dateTime")).toBe(false);
    expect(clock(container).textContent).toMatch(/00:00/);
  });

  // Value: protects=screen readers aren't interrupted every second (#106 accessibility); fails_when=aria-live or a live role is added to the clock or inside it; why_new=#106 done-when; seam=none; no_claim=what a real screen reader announces
  it("is not a live region", () => {
    const { container } = render(<UtcClock />);
    expect(container.querySelector("[aria-live], [role=status], [role=timer], [role=log], [role=alert]")).toBeNull();
  });
});
