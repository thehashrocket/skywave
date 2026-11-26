// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.fn();
vi.mock("@vercel/analytics", () => ({ track: (...args: unknown[]) => track(...args) }));

import { useListenTracking } from "./use-listen-tracking";
import type { RadioRefusal, RadioStatus } from "./use-radio";

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

  // Value: protects=a switch refused while the old station plays on still counts in radio_error by its code, once per refusal, so Vercel's skywave_cap counts include refused switches (#144); fails_when=refusals aren't tracked, or the same refusal is tracked again on a later render; why_new=refusals no longer arrive as error statuses; seam=mocked track; no_claim=Vercel ingestion
  it("counts a refused switch once, by its code", () => {
    const listening: RadioStatus = { state: "listening", host: "a.example", port: 8073 };
    const refusal: RadioRefusal = {
      seq: 1,
      host: "b.example",
      port: 8073,
      code: "skywave_cap",
      message: "x",
      stillOn: { host: "a.example", port: 8073 },
    };
    const hook = renderHook(({ refusal }) => useListenTracking(listening, false, refusal), {
      initialProps: { refusal: null as RadioRefusal | null },
    });
    hook.rerender({ refusal });
    hook.rerender({ refusal });
    expect(track.mock.calls).toEqual([["radio_error", { code: "skywave_cap" }]]);
  });
});
