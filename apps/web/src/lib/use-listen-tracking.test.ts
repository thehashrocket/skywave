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

  // Value: protects=Skywave's own cap never counts as radio_error (so before/after error rates need no filter) and counts once as radio_refused per refusal outside Pick best, whether it comes as a refused switch or an error status; inside a run it's left to the run (owner, final review); fails_when=skywave_cap reaches radio_error, a refusal is tracked twice on a later render, or a run's refusals are counted per receiver here too; why_new=radio_error mixed cap refusals with receiver failures; seam=mocked track; no_claim=Vercel ingestion
  it("counts Skywave's own cap as radio_refused, never radio_error, and leaves a run's to Pick best", () => {
    const listening: RadioStatus = { state: "listening", host: "a.example", port: 8073 };
    const capped: RadioStatus = { state: "error", code: "skywave_cap", host: "b.example", port: 8073 };
    const refusal = (seq: number): RadioRefusal => ({
      seq,
      host: "b.example",
      port: 8073,
      code: "skywave_cap",
      message: "x",
      stillOn: { host: "a.example", port: 8073 },
    });
    const hook = renderHook(
      ({ status, refusal, picking }) => useListenTracking(status, false, refusal, picking),
      { initialProps: { status: listening, refusal: null as RadioRefusal | null, picking: false } },
    );
    hook.rerender({ status: listening, refusal: refusal(1), picking: false });
    hook.rerender({ status: listening, refusal: refusal(1), picking: false });
    hook.rerender({ status: capped, refusal: refusal(1), picking: false });
    const once = ["radio_refused", { code: "skywave_cap", receivers: 1, source: "listener" }];
    expect(track.mock.calls).toEqual([once, once]);
    track.mockClear();
    hook.rerender({ status: listening, refusal: refusal(2), picking: true });
    hook.rerender({ status: { ...capped, host: "c.example" }, refusal: refusal(2), picking: true });
    expect(track.mock.calls).toEqual([]);
  });

  // Value: protects=Skywave being full (skywave_full, #146) counts as radio_refused, never radio_error, so lost connections and capacity refusals can be told apart; inside a Pick best run it's left to the run; fails_when=skywave_full reaches radio_error, isn't counted, or a run's is counted twice; why_new=the full refusal was uncoded and counted as radio_error "service"; seam=mocked track; no_claim=Vercel ingestion
  it("counts Skywave being full as radio_refused, never radio_error", () => {
    const full: RadioStatus = { state: "error", code: "skywave_full", host: "b.example", port: 8073, message: "full" };
    const hook = renderHook(({ status, picking }) => useListenTracking(status, false, null, picking), {
      initialProps: { status: full, picking: false },
    });
    expect(track.mock.calls).toEqual([["radio_refused", { code: "skywave_full", receivers: 1, source: "listener" }]]);
    track.mockClear();
    hook.rerender({ status: { state: "connecting" }, picking: true });
    hook.rerender({ status: { ...full }, picking: true });
    expect(track.mock.calls).toEqual([]);
  });
});
