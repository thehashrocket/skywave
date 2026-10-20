// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Receiver } from "./kiwi-list";
import { MAX_ATTEMPTS, usePickBest } from "./use-pick-best";
import { RADIO_ERROR_CODES, type RadioErrorCode, type RadioStatus } from "./use-radio";

function rx(host: string): Receiver {
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
  };
}

const candidates = ["a", "b", "c", "d"].map(rx);

function setup() {
  const tune = vi.fn();
  const hook = renderHook(({ status }) => usePickBest(status, tune), {
    initialProps: { status: { state: "idle" } as RadioStatus },
  });
  const report = (status: RadioStatus) => hook.rerender({ status });
  const tuned = () => tune.mock.calls.map(([r]) => (r as Receiver).host);
  return { hook, report, tuned };
}

const fail = (host: string, code: RadioErrorCode): RadioStatus => ({
  state: "error",
  host,
  port: 8073,
  code,
  message: "x",
});

describe("usePickBest", () => {
  it("tunes the top candidate", () => {
    const { hook, tuned } = setup();
    act(() => hook.result.current.start(candidates));
    expect(tuned()).toEqual(["a"]);
  });

  it("moves to the next receiver when one is full, and says so", () => {
    const { hook, report, tuned } = setup();
    act(() => hook.result.current.start(candidates));
    report(fail("a", "busy"));
    expect(tuned()).toEqual(["a", "b"]);
    expect(hook.result.current.note).toBe("A was full; trying B…");

    report({ state: "listening", host: "b", port: 8073 });
    expect(hook.result.current.note).toBeNull();
    report(fail("b", "closed")); // a later drop isn't part of the chain
    expect(tuned()).toEqual(["a", "b"]);
  });

  it.each(RADIO_ERROR_CODES.filter((c) => c !== "busy"))("retries on %s", (code) => {
    const { hook, report, tuned } = setup();
    act(() => hook.result.current.start(candidates));
    report(fail("a", code));
    expect(tuned()).toEqual(["a", "b"]);
  });

  it(`stops after ${MAX_ATTEMPTS} receivers`, () => {
    const { hook, report, tuned } = setup();
    act(() => hook.result.current.start(candidates));
    report(fail("a", "busy"));
    report(fail("b", "busy"));
    report(fail("c", "busy"));
    expect(tuned()).toEqual(["a", "b", "c"]);
    expect(hook.result.current.note).toMatch(/Tried 3 receivers/);
  });

  it("stops at once on a failure that isn't about the receiver", () => {
    const { hook, report, tuned } = setup();
    act(() => hook.result.current.start(candidates));
    report({ state: "error", message: "The radio service is at its listener limit." });
    expect(tuned()).toEqual(["a"]);
    expect(hook.result.current.note).toBeNull();
  });

  it("ignores a late error from an earlier attempt", () => {
    const { hook, report, tuned } = setup();
    act(() => hook.result.current.start(candidates));
    report(fail("a", "busy"));
    report({ state: "connecting", host: "b", port: 8073 });
    report(fail("a", "closed"));
    report({ ...fail("b", "busy"), port: 8074 }); // same host, different receiver
    expect(tuned()).toEqual(["a", "b"]);
  });

  it("does nothing more after cancel", () => {
    const { hook, report, tuned } = setup();
    act(() => hook.result.current.start(candidates));
    act(() => hook.result.current.cancel());
    report(fail("a", "busy"));
    expect(tuned()).toEqual(["a"]);
  });

  it("stops when it runs out of candidates before the cap", () => {
    const { hook, report, tuned } = setup();
    act(() => hook.result.current.start([rx("a")]));
    report(fail("a", "busy"));
    expect(tuned()).toEqual(["a"]);
    expect(hook.result.current.note).toBe("Tried 1 receiver and it didn't work. Pick one from the list.");
  });

  it("says why it skipped a receiver", () => {
    const { hook, report } = setup();
    act(() => hook.result.current.start(candidates));
    report(fail("a", "blocked"));
    expect(hook.result.current.note).toBe("A is on a private address; trying B…");
    report(fail("b", "unreachable"));
    expect(hook.result.current.note).toBe("B didn't answer; trying C…");
  });

  // Value: protects=a second click retries instead of reading the last run's error as its answer; fails_when=the start-status guard is removed; why_new=Codex structured review [P2]; seam=none; no_claim=real socket timing
  it("gives a repeat click a real attempt even while the last error is still showing", () => {
    const { hook, report, tuned } = setup();
    act(() => hook.result.current.start([rx("a")]));
    report(fail("a", "busy"));
    expect(hook.result.current.note).toMatch(/Tried 1 receiver/);

    act(() => hook.result.current.start([rx("a")]));
    expect(tuned()).toEqual(["a", "a"]);
    expect(hook.result.current.note).toBeNull();
    report(fail("a", "busy"));
    expect(hook.result.current.note).toMatch(/Tried 1 receiver/);
  });

  // Value: protects=a failed Pick best during a live session doesn't leave the listener in silence; fails_when=the fallback tune is removed; why_new=red team found switching drops the working receiver; seam=none; no_claim=the old receiver still having a free slot
  it("goes back to the receiver that was playing when every try fails", () => {
    const { hook, report, tuned } = setup();
    report({ state: "listening", host: "home.example", port: 8073 });
    act(() => hook.result.current.start([rx("a"), rx("b")]));
    report(fail("a", "busy"));
    report(fail("b", "busy"));
    expect(tuned()).toEqual(["a", "b", "home.example"]);
    expect(hook.result.current.note).toBe("Tried 2 receivers and none worked. Back on home.example.");
  });

  it("doesn't go back to a receiver it already tried", () => {
    const { hook, report, tuned } = setup();
    report({ state: "listening", host: "a", port: 8073 });
    act(() => hook.result.current.start([rx("a")]));
    report(fail("a", "busy"));
    expect(tuned()).toEqual(["a"]);
    expect(hook.result.current.note).toMatch(/Pick one from the list/);
  });

  it("goes back to a typed-in receiver without marking it as a list tune", () => {
    const tune = vi.fn();
    const hook = renderHook(({ status }) => usePickBest(status, tune), {
      initialProps: { status: { state: "listening", host: "my-lan-kiwi", port: 8073 } as RadioStatus },
    });
    act(() => hook.result.current.start([rx("a")]));
    hook.rerender({ status: fail("a", "busy") });
    expect(tune.mock.calls.map(([r, fromList]) => [(r as Receiver).host, fromList])).toEqual([
      ["a", true],
      ["my-lan-kiwi", false],
    ]);
  });

  // Value: protects=Stop picking mid-run doesn't leave the listener in silence; fails_when=stop() stops going back; why_new=red team found Stop dropped the working receiver; seam=none; no_claim=the old receiver still having a free slot
  it("goes back to what was playing when Stop picking is pressed", () => {
    const { hook, report, tuned } = setup();
    report({ state: "listening", host: "home.example", port: 8073 });
    act(() => hook.result.current.start(candidates));
    act(() => hook.result.current.stop());
    expect(tuned()).toEqual(["a", "home.example"]);
    expect(hook.result.current.note).toBe("Stopped. Back on home.example.");
    expect(hook.result.current.running).toBe(false);
  });

  it("just stops when Stop picking is pressed with nothing to go back to", () => {
    const { hook, tuned } = setup();
    act(() => hook.result.current.start(candidates));
    act(() => hook.result.current.stop());
    expect(tuned()).toEqual(["a"]);
    expect(hook.result.current.note).toBeNull();
  });

  // Value: protects=a few dead or private list entries can't end every Pick best run; fails_when=address refusals count toward MAX_ATTEMPTS again; why_new=red team: three bad entries could exhaust the tries; seam=none; no_claim=real DNS timing
  it("doesn't count instant address refusals against the tries, up to a total cap", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"].map(rx);
    const { hook, report, tuned } = setup();
    act(() => hook.result.current.start(many));
    report(fail("a", "dns"));
    report(fail("b", "blocked"));
    report(fail("c", "invalid"));
    report(fail("d", "busy"));
    expect(tuned()).toEqual(["a", "b", "c", "d", "e"]);
    report(fail("e", "dns"));
    report(fail("f", "dns"));
    expect(tuned()).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(hook.result.current.note).toMatch(/Tried 6 receivers/);
  });

  it("stops without going back when the service itself fails mid-run", () => {
    const { hook, report, tuned } = setup();
    report({ state: "listening", host: "home.example", port: 8073 });
    act(() => hook.result.current.start(candidates));
    report({ state: "error", message: "Lost the connection to the radio service. Is it running?" });
    expect(tuned()).toEqual(["a"]);
    expect(hook.result.current.running).toBe(false);
  });

  // Value: protects=retries after a dial move only try receivers that cover the new frequency; fails_when=accepts is ignored; why_new=Codex: candidates were ranked once for the old dial; seam=none; no_claim=re-ranking by SNR at the new frequency
  it("skips candidates the dial has moved away from", () => {
    const tune = vi.fn();
    let accepts = (_: Receiver) => true;
    const hook = renderHook(({ status }) => usePickBest(status, tune, (r) => accepts(r)), {
      initialProps: { status: { state: "idle" } as RadioStatus },
    });
    act(() => hook.result.current.start(candidates));
    accepts = (r) => r.host !== "b";
    hook.rerender({ status: fail("a", "busy") });
    expect(tune.mock.calls.map(([r]) => (r as Receiver).host)).toEqual(["a", "c"]);
  });

  it("tells the caller when Stop picking had nothing to go back to", () => {
    const { hook, report } = setup();
    act(() => hook.result.current.start(candidates));
    let wentBack: boolean | undefined;
    act(() => {
      wentBack = hook.result.current.stop();
    });
    expect(wentBack).toBe(false);
    report({ state: "listening", host: "home.example", port: 8073 });
    act(() => hook.result.current.start(candidates));
    act(() => {
      wentBack = hook.result.current.stop();
    });
    expect(wentBack).toBe(true);
  });

  // Value: protects=going back to a list receiver keeps its list tag when it's outside the candidates; fails_when=playing() infers fromList only from the frequency-filtered candidates; why_new=security review; seam=none; no_claim=the page's wasListed wiring (page test)
  it("goes back to a list receiver outside the candidates with its list tag", () => {
    const tune = vi.fn();
    const hook = renderHook(({ status }) => usePickBest(status, tune, undefined, (h) => h === "listed.example"), {
      initialProps: { status: { state: "listening", host: "listed.example", port: 8073 } as RadioStatus },
    });
    act(() => hook.result.current.start(candidates));
    act(() => {
      hook.result.current.stop();
    });
    expect(tune.mock.calls.at(-1)).toEqual([expect.objectContaining({ host: "listed.example" }), true]);
  });

  // Value: protects=an address refusal mid-run neither strikes nor loses the way back; fails_when=address codes count as strikes or the fallback is dropped on one; why_new=state matrix fallback x address-error; seam=none; no_claim=real DNS
  it("keeps the way back through an address refusal", () => {
    const { hook, report, tuned } = setup();
    report({ state: "listening", host: "home.example", port: 8073 });
    act(() => hook.result.current.start(candidates));
    report(fail("a", "dns"));
    report(fail("b", "busy"));
    report(fail("c", "busy"));
    report(fail("d", "busy"));
    expect(tuned()).toEqual(["a", "b", "c", "d", "home.example"]);
    expect(hook.result.current.note).toMatch(/Back on home\.example/);
  });

  it("reports whether a run is in progress", () => {
    const { hook, report } = setup();
    expect(hook.result.current.running).toBe(false);
    act(() => hook.result.current.start(candidates));
    expect(hook.result.current.running).toBe(true);
    report({ state: "listening", host: "a", port: 8073 });
    expect(hook.result.current.running).toBe(false);
  });

  it("explains when nothing covers the frequency", () => {
    const { hook, tuned } = setup();
    act(() => hook.result.current.start([]));
    expect(tuned()).toEqual([]);
    expect(hook.result.current.note).toMatch(/No listed receiver/);
  });
});
