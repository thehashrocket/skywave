// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.fn();
vi.mock("@vercel/analytics", () => ({ track: (...args: unknown[]) => track(...args) }));

import { useListenTracking } from "./use-listen-tracking";
import type { RadioStatus } from "./use-radio";

type Props = { status: RadioStatus; heard: boolean };
const listening = (host: string, freqKhz = 9_420): RadioStatus => ({ state: "listening", host, port: 8073, freqKhz, mode: "am" });

function setup(initial: Props) {
  return renderHook((p: Props) => useListenTracking(p.status, p.heard), { initialProps: initial });
}

const starts = () => track.mock.calls.filter(([name]) => name === "listen_start");

describe("useListenTracking", () => {
  beforeEach(() => track.mockClear());

  it("counts a listen once audio plays, not when the receiver connects", () => {
    const { rerender } = setup({ status: { state: "connecting" }, heard: false });
    rerender({ status: listening("a.example"), heard: false });
    expect(starts()).toHaveLength(0);
    rerender({ status: listening("a.example"), heard: true });
    expect(starts()).toEqual([["listen_start", { mode: "am", mhz: 9 }]]);
  });

  it("doesn't count a retune on the same receiver again, but counts a new receiver", () => {
    const { rerender } = setup({ status: listening("a.example"), heard: true });
    rerender({ status: listening("a.example", 6_070), heard: false });
    rerender({ status: listening("a.example", 6_070), heard: true });
    expect(starts()).toHaveLength(1);
    rerender({ status: listening("b.example"), heard: true });
    expect(starts()).toHaveLength(2);
  });

  it("counts the same receiver again after a stop", () => {
    const { rerender } = setup({ status: listening("a.example"), heard: true });
    rerender({ status: { state: "stopped" }, heard: false });
    rerender({ status: listening("a.example"), heard: true });
    expect(starts()).toHaveLength(2);
  });

  it("reports errors by code, and our own uncoded ones as service", () => {
    const { rerender } = setup({ status: { state: "error", code: "busy" }, heard: false });
    rerender({ status: { state: "error", message: "Skywave is at its listener limit" }, heard: false });
    expect(track.mock.calls).toEqual([
      ["radio_error", { code: "busy" }],
      ["radio_error", { code: "service" }],
    ]);
  });
});
