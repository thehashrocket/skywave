// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Receiver } from "./kiwi-list";
import { MAX_ATTEMPTS, REFUSED_MS, usePickBest, WATCH_MS } from "./use-pick-best";
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

  // Value: protects=a receiver that refuses apps isn't reported as full; fails_when=no_apps loses its own note or maps to busy's; why_new=too_busy=0 read "was full" before; seam=none; no_claim=none beyond protects
  it("says why it left a receiver that refuses apps", () => {
    const { hook, report } = setup();
    act(() => hook.result.current.start(candidates));
    report(fail("a", "no_apps"));
    expect(hook.result.current.note).toBe("A only takes listeners on its own web page; trying B…");
  });

  describe("after the receiver starts playing", () => {
    type Harness = ReturnType<typeof setup>;
    const listening = (host: string): RadioStatus => ({ state: "listening", host, port: 8073 });
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // Value: protects=a receiver that refuses apps ~10 s into audio sends the run on to the next one, with its note; fails_when=the run ends for good on listening; why_new=live probe 2026-10-21 (no_apps at 10.8 s); seam=none; no_claim=live Kiwi timing (status sequence)
    it("moves on when the receiver refuses apps within the watch, looking finished until then", () => {
      const { hook, report, tuned } = setup();
      act(() => hook.result.current.start(candidates));
      report(listening("a"));
      expect(hook.result.current.running).toBe(false);
      expect(hook.result.current.note).toBeNull();
      act(() => vi.advanceTimersByTime(WATCH_MS - 1));
      report(fail("a", "no_apps"));
      expect(tuned()).toEqual(["a", "b"]);
      expect(hook.result.current.running).toBe(true);
      expect(hook.result.current.note).toBe("A only takes listeners on its own web page; trying B…");
    });

    // Value: protects=settled stays false through the whole watch (a late refusal can still switch receivers) and turns true, re-rendering, when the watch runs out; fails_when=settled follows running, or the watch's expiry changes only a ref; why_new=band scan waits for it (eng review D14, Codex O4); seam=none; no_claim=live Kiwi timing
    it("is settled only once the watch ends, not when the receiver starts playing", () => {
      const { hook, report } = setup();
      expect(hook.result.current.settled).toBe(true);
      act(() => hook.result.current.start(candidates));
      expect(hook.result.current.settled).toBe(false);
      report(listening("a"));
      expect(hook.result.current.running).toBe(false);
      expect(hook.result.current.settled).toBe(false);
      act(() => vi.advanceTimersByTime(WATCH_MS - 1));
      report(fail("a", "no_apps"));
      expect(hook.result.current.settled).toBe(false);
      report(listening("b"));
      act(() => vi.advanceTimersByTime(WATCH_MS));
      expect(hook.result.current.settled).toBe(true);
    });

    // Value: protects=the watch ends: a refusal after it, after another failure, or after the listener moved on starts nothing, and the run reads settled; fails_when=the watch timer or the cancel/other-status paths are missing, so a late refusal re-tunes behind the listener's back, or finish() stops setting settled so the band scan never starts; why_new=hidden watch (eng review D4); another-receiver and service-drop rows from ship review (state-machines); seam=none; no_claim=live Kiwi timing
    it.each<[string, (h: Harness) => void]>([
      ["the watch ran out", () => act(() => vi.advanceTimersByTime(WATCH_MS))],
      ["the listener chose another receiver", (h) => act(() => h.hook.result.current.cancel())],
      ["the receiver hung up first", (h) => h.report(fail("a", "closed"))],
      ["the radio stopped", (h) => h.report({ state: "stopped" })],
      ["another receiver started playing", (h) => h.report(listening("z"))],
      [
        "the radio service dropped",
        (h) => h.report({ state: "error", message: "Lost the connection to the radio service. Is it running?" }),
      ],
    ])("ignores a refusal once %s", (_case, end) => {
      const h = setup();
      act(() => h.hook.result.current.start(candidates));
      h.report(listening("a"));
      end(h);
      // However the watch ends, the run is settled, so the page's band scan can start.
      expect(h.hook.result.current.settled).toBe(true);
      h.report(fail("a", "no_apps"));
      expect(h.tuned()).toEqual(["a"]);
      expect(h.hook.result.current.running).toBe(false);
    });

    // Value: protects=moving the dial keeps the watch, and the run then moves on only to receivers covering the new frequency; fails_when=a retune of the same receiver ends the watch, or the resume ignores the dial; why_new=eng review D7; seam=none; no_claim=page wiring of retunes (page tests)
    it("keeps watching through a dial move and moves on to a receiver that covers the new frequency", () => {
      const tune = vi.fn();
      let dialKhz = 10_000;
      const lowOnly = { ...rx("b"), maxKhz: 12_000 };
      const hook = renderHook(({ status }) => usePickBest(status, tune, (r) => dialKhz <= r.maxKhz), {
        initialProps: { status: { state: "idle" } as RadioStatus },
      });
      act(() => hook.result.current.start([rx("a"), lowOnly, rx("c")]));
      hook.rerender({ status: listening("a") });
      dialKhz = 15_000;
      hook.rerender({ status: { state: "connecting", host: "a", port: 8073 } });
      hook.rerender({ status: listening("a") });
      hook.rerender({ status: fail("a", "no_apps") });
      expect(tune.mock.calls.map(([r]) => (r as Receiver).host)).toEqual(["a", "c"]);
    });

    // Value: protects=a late refusal with no receiver left to try still goes back to what played before the run, and says so; fails_when=the watch's resume ends the run on its own instead of taking the usual give-up path (silence, no note); why_new=ship coverage audit (feat/web-follow-ups): the resume was only tested with candidates left; seam=none; no_claim=live Kiwi timing
    it("goes back to what played before the run when a late refusal leaves nothing to try", () => {
      const { hook, report, tuned } = setup();
      report(listening("home.example"));
      act(() => hook.result.current.start([rx("a")]));
      report(listening("a"));
      act(() => vi.advanceTimersByTime(WATCH_MS - 1));
      report(fail("a", "no_apps"));
      expect(tuned()).toEqual(["a", "home.example"]);
      expect(hook.result.current.running).toBe(false);
      expect(hook.result.current.note).toBe("Tried 1 receiver and it didn't work. Going back to home.example…");
      report(listening("home.example"));
      expect(hook.result.current.note).toBe("Tried 1 receiver and it didn't work. Back on home.example.");
    });

    // Value: protects=Stop picking during the watch ends it without redialing what played before the run and without asking the page to stop the receiver that plays, and a later refusal starts nothing; fails_when=stop() goes back to the fallback, returns false (the page then stops the radio) or leaves the watch running; why_new=hidden watch; ship review (maintainability, plan audit partial); seam=none; no_claim=page Stop wiring
    it("ends the watch on Stop and leaves the receiver playing", () => {
      const tune = vi.fn();
      const hook = renderHook(({ status }) => usePickBest(status, tune), {
        initialProps: { status: listening("old") },
      });
      act(() => hook.result.current.start(candidates));
      hook.rerender({ status: listening("a") });
      let handled = false;
      act(() => {
        handled = hook.result.current.stop();
      });
      expect(handled).toBe(true);
      hook.rerender({ status: fail("a", "no_apps") });
      expect(tune.mock.calls.map(([r]) => (r as Receiver).host)).toEqual(["a"]);
      expect(hook.result.current.running).toBe(false);
    });

    // Value: protects=a new Pick best run started during the watch runs on its own, and the old watch's timer can't end it; fails_when=start() leaves the old watch timer pending, so it nulls the new chain WATCH_MS later; why_new=ship review (state-machines: watching x start); seam=none; no_claim=none beyond protects
    it("isn't ended by the old watch when a new run starts during it", () => {
      const { hook, report, tuned } = setup();
      act(() => hook.result.current.start(candidates));
      report(listening("a"));
      act(() => hook.result.current.start([rx("c"), rx("d")]));
      expect(hook.result.current.running).toBe(true);
      act(() => vi.advanceTimersByTime(WATCH_MS));
      report(fail("c", "busy"));
      expect(tuned()).toEqual(["a", "c", "d"]);
    });
  });

  it.each(RADIO_ERROR_CODES.filter((c) => c !== "busy"))("retries on %s", (code) => {
    const { hook, report, tuned } = setup();
    act(() => hook.result.current.start(candidates));
    report(fail("a", code));
    expect(tuned()).toEqual(["a", "b"]);
  });

  // Value: protects=a lookup stuck on an earlier dead name costs one wait, not the run; fails_when=retryAfterMs is ignored (run stops) or retried forever; why_new=R7 retry hint; seam=none; no_claim=real resolver timing (fake timers)
  it("waits out a retry hint once, then stops if it comes back", () => {
    vi.useFakeTimers();
    try {
      const { hook, report, tuned } = setup();
      act(() => hook.result.current.start(candidates));
      const stuck: RadioStatus = {
        state: "error",
        host: "a",
        port: 8073,
        message: "Still waiting",
        retryAfterMs: 5000,
      };
      report(stuck);
      expect(tuned()).toEqual(["a"]);
      expect(hook.result.current.running).toBe(true);
      act(() => vi.advanceTimersByTime(5000));
      expect(tuned()).toEqual(["a", "a"]);

      report({ state: "connecting", host: "a", port: 8073 });
      report({ ...stuck });
      act(() => vi.advanceTimersByTime(10_000));
      expect(tuned()).toEqual(["a", "a"]);
      expect(hook.result.current.running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't fire a pending retry after the run is cancelled", () => {
    vi.useFakeTimers();
    try {
      const { hook, report, tuned } = setup();
      act(() => hook.result.current.start(candidates));
      report({ state: "error", host: "a", port: 8073, message: "Still waiting", retryAfterMs: 5000 });
      act(() => hook.result.current.cancel());
      act(() => vi.advanceTimersByTime(5000));
      expect(tuned()).toEqual(["a"]);
    } finally {
      vi.useRealTimers();
    }
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
    // An uncoded error is the service's, so the receiver can be tried again at once.
    const serviceError: RadioStatus = { state: "error", host: "a", port: 8073, message: "listener limit" };
    act(() => hook.result.current.start([rx("a")]));
    report(serviceError);
    expect(hook.result.current.running).toBe(false);

    act(() => hook.result.current.start([rx("a")]));
    expect(tuned()).toEqual(["a", "a"]);
    expect(hook.result.current.running).toBe(true); // the still-showing error isn't this run's answer
  });

  // Value: protects=receivers that refused (in a run or tuned by hand) aren't redialed by the next run for REFUSED_MS, so a no_apps or full Kiwi doesn't cut the listener off again, while one that plays again, drops and timeouts don't count (state-machines review); fails_when=start ignores earlier refusals, keys miss case or the default port, uncoded errors or drops count, or playing doesn't clear a refusal; why_new=the list's stale counts rank them first again; seam=none; no_claim=real Kiwi slot timing
  it("leaves out receivers that refused recently, until REFUSED_MS has passed", () => {
    vi.useFakeTimers();
    try {
      const { hook, report, tuned } = setup();
      act(() => hook.result.current.start(candidates));
      report(fail("a", "busy"));
      report(fail("b", "no_apps"));
      report(fail("c", "busy")); // the run gives up
      act(() => hook.result.current.start(candidates));
      expect(tuned()).toEqual(["a", "b", "c", "d"]);

      // A receiver tuned by hand that refuses counts too, whatever the case or a missing port.
      report({ state: "error", host: "D", code: "password", message: "x" });
      act(() => hook.result.current.start([rx("d")]));
      expect(tuned()).toHaveLength(4);
      expect(hook.result.current.note).toBe(
        "D is the only listed receiver for this frequency, and it just refused. Try again in 15 minutes, or pick another frequency.",
      );
      act(() => hook.result.current.start(candidates));
      expect(hook.result.current.note).toMatch(/^Every listed receiver for this frequency refused/);

      // Drops and timeouts (one network blip) don't count either.
      const blip = setup();
      blip.report(fail("a", "closed"));
      blip.report(fail("b", "timeout"));
      // Nor do address/setup errors or the service's own network trouble.
      blip.report(fail("c", "dns"));
      blip.report(fail("d", "unreachable"));
      act(() => blip.hook.result.current.start([rx("c"), rx("d")]));
      expect(blip.tuned()).toEqual(["c"]);

      // A receiver that refused and then plays (a slot opened) can be picked again.
      const back = setup();
      back.report(fail("a", "busy"));
      back.report({ state: "listening", host: "A", port: 8073 });
      act(() => back.hook.result.current.start(candidates));
      expect(back.tuned()).toEqual(["a"]);

      // The service's own errors don't count against a receiver.
      const fresh = setup();
      fresh.report({ state: "error", host: "a", port: 8073, message: "listener limit" });
      act(() => fresh.hook.result.current.start(candidates));
      expect(fresh.tuned()).toEqual(["a"]);

      act(() => vi.advanceTimersByTime(REFUSED_MS));
      act(() => hook.result.current.start(candidates));
      expect(tuned()).toEqual(["a", "b", "c", "d", "a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=a failed Pick best during a live session doesn't leave the listener in silence; fails_when=the fallback tune is removed; why_new=red team found switching drops the working receiver; seam=none; no_claim=the old receiver still having a free slot
  it("goes back to the receiver that was playing when every try fails", () => {
    const { hook, report, tuned } = setup();
    report({ state: "listening", host: "home.example", port: 8073 });
    act(() => hook.result.current.start([rx("a"), rx("b")]));
    report(fail("a", "busy"));
    report(fail("b", "busy"));
    expect(tuned()).toEqual(["a", "b", "home.example"]);
    // Not "Back on" until it really is.
    expect(hook.result.current.note).toBe("Tried 2 receivers and none worked. Going back to home.example…");
    expect(hook.result.current.running).toBe(false);
    report({ state: "connecting", host: "home.example", port: 8073 });
    report({ state: "listening", host: "home.example", port: 8073 });
    expect(hook.result.current.note).toBe("Tried 2 receivers and none worked. Back on home.example.");
  });

  // Value: protects=the note never claims Pick best got back when the reconnect failed; fails_when=the note is set before the fallback answers; why_new=TODOS small edges ("Back on X" too early); seam=none; no_claim=why the old receiver refused
  it("says so when it can't get back to what was playing", () => {
    const { hook, report, tuned } = setup();
    report({ state: "listening", host: "home.example", port: 8073 });
    act(() => hook.result.current.start([rx("a")]));
    report(fail("a", "busy"));
    report(fail("a", "closed")); // late news from the abandoned attempt is ignored
    expect(hook.result.current.note).toMatch(/Going back to home\.example/);
    report({ state: "error", code: "busy", host: "home.example", port: 8073, message: "full" });
    expect(tuned()).toEqual(["a", "home.example"]);
    expect(hook.result.current.note).toBe("Tried 1 receiver and it didn't work. Couldn't get back to home.example.");
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
    expect(hook.result.current.note).toBe("Stopped. Going back to home.example…");
    expect(hook.result.current.running).toBe(false);
    report({ state: "listening", host: "home.example", port: 8073 });
    expect(hook.result.current.note).toBe("Stopped. Back on home.example.");
  });

  // Value: protects=Pick best started while a typed receiver is still connecting can go back to it; fails_when=playing() only counts "listening"; why_new=TODOS Pick best edges; seam=none; no_claim=that receiver eventually connecting
  it("goes back to a receiver that was still connecting when the run started", () => {
    const { hook, report, tuned } = setup();
    report({ state: "connecting", host: "typed.example", port: 8073 });
    act(() => hook.result.current.start([rx("a")]));
    report(fail("a", "busy"));
    expect(tuned()).toEqual(["a", "typed.example"]);
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

  // Value: protects=going back to a list receiver keeps its list tag when it's outside the candidates; fails_when=playing() infers fromList only from the frequency-filtered candidates; why_new=security review; seam=none; no_claim=the page's provenance wiring (page test)
  it("goes back to a list receiver outside the candidates with its list tag", () => {
    const tune = vi.fn();
    const provenance = (h: string) => ({ fromList: h === "listed.example", secure: false });
    const hook = renderHook(({ status }) => usePickBest(status, tune, undefined, provenance), {
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
    expect(hook.result.current.note).toMatch(/Going back to home\.example/);
  });

  // Value: protects=a receiver you typed that is also listed comes back typed (dialed with your rule), and an https one comes back over wss; fails_when=playing() takes provenance from the matching candidate row; why_new=TODOS provenance (pass-2/3 red team); seam=none; no_claim=the page's provenance (page test)
  it("takes the way back's list tag and scheme from the page, not from a matching candidate", () => {
    const tune = vi.fn();
    const provenance = () => ({ fromList: false, secure: true });
    const hook = renderHook(({ status }) => usePickBest(status, tune, undefined, provenance), {
      initialProps: { status: { state: "listening", host: "b", port: 8073 } as RadioStatus },
    });
    act(() => hook.result.current.start(candidates.filter((r) => r.host !== "b").concat(rx("b"))));
    act(() => {
      hook.result.current.stop();
    });
    expect(tune.mock.calls.at(-1)).toEqual([expect.objectContaining({ host: "b", name: "B", secure: true }), false]);
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

  // Value: protects=choosing something else while Pick best is going back ends the return cleanly; fails_when=a returning chain keeps reacting after cancel; why_new=state matrix fallback x cancel; seam=none; no_claim=none beyond protects
  it("forgets the way back once cancelled", () => {
    const { hook, report } = setup();
    report({ state: "listening", host: "home.example", port: 8073 });
    act(() => hook.result.current.start([rx("a")]));
    report(fail("a", "busy"));
    act(() => hook.result.current.cancel());
    report({ state: "listening", host: "home.example", port: 8073 });
    expect(hook.result.current.note).toBeNull();
  });
});
