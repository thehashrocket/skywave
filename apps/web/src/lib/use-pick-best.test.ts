// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.fn();
vi.mock("@vercel/analytics", () => ({ track: (...args: unknown[]) => track(...args) }));
import type { Receiver } from "./kiwi-list";
import { PICK_CONTEXT_VERSION } from "./pick-context";
import { MAX_ATTEMPTS, REFUSED_MS, usePickBest, WATCH_MS } from "./use-pick-best";
import { noteResponse, resetServerClock, serverNow } from "./server-clock";
import { RADIO_ERROR_CODES, type RadioErrorCode, type RadioRefusal, type RadioStatus } from "./use-radio";

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

    // Value: protects=a receiver that refuses on its own account within the watch (no apps ~10 s in, or full, as a live Kiwi did at 10 s, or a password) sends the run on to the next one, with its note; fails_when=the run ends for good on listening, or only no_apps moves on and a late "full" leaves the listener on an error; why_new=live probe 2026-10-21 (no_apps at 10.8 s); browser check 2026-11-10 (a Kiwi played, then said busy at 10.7 s, and Pick best stopped); seam=none; no_claim=live Kiwi timing (status sequence)
    it.each<[RadioErrorCode, string]>([
      ["no_apps", "A only takes listeners on its own web page; trying B…"],
      ["busy", "A was full; trying B…"],
      ["password", "A needs a password; trying B…"],
    ])("moves on when the receiver refuses (%s) within the watch, looking finished until then", (code, note) => {
      const { hook, report, tuned } = setup();
      act(() => hook.result.current.start(candidates));
      report(listening("a"));
      expect(hook.result.current.running).toBe(false);
      expect(hook.result.current.note).toBeNull();
      act(() => vi.advanceTimersByTime(WATCH_MS - 1));
      report(fail("a", code));
      expect(tuned()).toEqual(["a", "b"]);
      expect(hook.result.current.running).toBe(true);
      expect(hook.result.current.note).toBe(note);
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

  // Value: protects=isRefused, which the better-receiver offer reads, answers from the same memory as a run: a recent refusal (any case, default port) until REFUSED_MS or until it plays; fails_when=it keeps a second definition that drifts from start's filter; why_new=the switch prompt must not offer a receiver that just refused; seam=fake timers; no_claim=the run's own filtering (test above)
  it("reports recent refusals through isRefused", () => {
    vi.useFakeTimers();
    try {
      const { hook, report } = setup();
      const refused = (host: string) => hook.result.current.isRefused({ host, port: 8073 });
      report({ state: "error", host: "A", code: "busy", message: "x" });
      expect(refused("a")).toBe(true);
      expect(refused("b")).toBe(false);
      act(() => vi.advanceTimersByTime(REFUSED_MS));
      expect(refused("a")).toBe(false);
      report(fail("b", "no_apps"));
      expect(refused("b")).toBe(true);
      report({ state: "listening", host: "b", port: 8073 });
      expect(refused("b")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("how it chose, for reception reports (#61)", () => {
    const NOW = Date.UTC(2026, 10, 18, 12);
    const run = { source: "listen" as const, freqKhz: 9_580 };
    beforeEach(() => vi.useFakeTimers({ now: NOW }));
    afterEach(() => vi.useRealTimers());

    // Value: protects=the receiver a run tunes carries when it was tuned, the run's source and frequency, its place in the list as given (refused ones counted), the top of that list and its listed details; fails_when=rank counts in the filtered candidates, the time is the run's start for a later candidate, or details are read later; why_new=pick context (D5); seam=none; no_claim=serverNow's offset (server-clock tests)
    it("records the receiver each tune chose, ranked within the list as given", () => {
      const { hook, report } = setup();
      // "a" refused a moment ago, so the run starts at "b", second in the list it was given.
      report(fail("a", "busy"));
      act(() => hook.result.current.start(candidates, candidates, run));
      expect(hook.result.current.pickedFor("b", 8073)).toEqual({
        version: PICK_CONTEXT_VERSION,
        pickedAtMs: NOW,
        pickSource: "listen",
        rankPos: 1,
        candidates: ["a:8073", "b:8073", "c:8073", "d:8073"],
        freqKhz: 9_580,
        snr: 20,
        users: 0,
      });
      expect(hook.result.current.pickedFor("a", 8073)).toBeNull();

      act(() => vi.advanceTimersByTime(4_000));
      report(fail("b", "busy"));
      expect(hook.result.current.pickedFor("b", 8073)).toBeNull();
      expect(hook.result.current.pickedFor("C", 8073)).toMatchObject({ pickedAtMs: NOW + 4_000, rankPos: 2 });
    });

    // Value: protects=a pick made through a forward clock jump not yet re-measured keeps its context when the jump was a sleep (a measurement that leaves the time alone, then later clock news), and drops it, counting a drop, when the time then moves before any measurement (a change by hand corrected, or a jump undone); fails_when=every pick through an unmeasured jump loses context (every laptop wake), or a corrected pick time is kept; why_new=owner: drop only if corrected; seam=fake timers (setSystemTime moves only Date), the real server clock fed responses; no_claim=how a browser pauses performance.now in sleep
    describe("a pick made through an unmeasured clock jump", () => {
      beforeEach(() => {
        resetServerClock();
        noteResponse(new Headers({ date: new Date(NOW).toUTCString() }), Date.now(), Date.now());
      });
      afterEach(() => resetServerClock());

      it("keeps its context after a sleep", async () => {
        const { hook } = setup();
        // Ten minutes asleep: the computer's clock and the server moved on, performance.now() didn't.
        vi.setSystemTime(Date.now() + 600_000);
        act(() => hook.result.current.start(candidates, candidates, run));
        const drops = hook.result.current.dropCount();
        const at = hook.result.current.pickedFor("a", 8073)!.pickedAtMs;
        // The computer's time, which kept going through the sleep (the Date header's rounding aside).
        expect(Math.abs(at - (NOW + 600_000))).toBeLessThanOrEqual(500);
        await act(async () => {});
        // The re-measure agrees with the time shown, then later clock news arrives.
        noteResponse(new Headers({ date: new Date(Date.now()).toUTCString() }), Date.now() - 100, Date.now());
        vi.setSystemTime(Date.now() + 600_000);
        await act(async () => void serverNow());
        expect(hook.result.current.pickedFor("a", 8073)).toMatchObject({ rankPos: 0, pickedAtMs: at });
        expect(hook.result.current.dropCount()).toBe(drops);
        // Value (extension): protects=any later correction drops even a pick the sleep's measurement proved right, since its time and a question's slot would then sit on different offsets; fails_when=a correction drops only picks made through an unmeasured jump; why_new=P4 TODO (owner: drop picks on any correction); seam=fake timers, the real server clock fed responses; no_claim=none beyond protects
        act(() =>
          noteResponse(new Headers({ date: new Date(Date.now() - 600_000).toUTCString() }), Date.now() - 100, Date.now()),
        );
        expect(hook.result.current.pickedFor("a", 8073)).toBeNull();
        expect(hook.result.current.dropCount()).toBe(drops + 1);
      });

      it("drops it when the re-measure corrects a change by hand", async () => {
        const { hook } = setup();
        // An hour forward by hand: the server didn't move.
        vi.setSystemTime(Date.now() + 3_600_000);
        act(() => hook.result.current.start(candidates, candidates, run));
        const drops = hook.result.current.dropCount();
        await act(async () => {});
        expect(hook.result.current.pickedFor("a", 8073)).not.toBeNull();
        act(() => noteResponse(new Headers({ date: new Date(NOW).toUTCString() }), Date.now() - 100, Date.now()));
        expect(hook.result.current.pickedFor("a", 8073)).toBeNull();
        expect(hook.result.current.dropCount()).toBe(drops + 1);
      });

      // Value: protects=a pick made before the page's first measurement (a cold server's slow replies) keeps its context when the first measurement agrees with the computer's clock, and loses it when that measurement corrects the time; fails_when=a pick before any measurement counts as settled whatever the first measurement finds; why_new=round 3 final review (pick before the first measurement); seam=fake timers, the real server clock fed responses; no_claim=none beyond protects
      it.each([
        ["keeps", 0],
        ["drops", 3_000],
      ])("%s a pick made before the first measurement as that measurement finds %i ms", (verb, off) => {
        resetServerClock();
        const { hook } = setup();
        act(() => hook.result.current.start(candidates, candidates, run));
        expect(hook.result.current.pickedFor("a", 8073)).not.toBeNull();
        act(() => noteResponse(new Headers({ "x-server-ms": String(Date.now() + off) }), Date.now(), Date.now()));
        if (verb === "keeps") expect(hook.result.current.pickedFor("a", 8073)).toMatchObject({ rankPos: 0 });
        else expect(hook.result.current.pickedFor("a", 8073)).toBeNull();
      });

      it("drops it when the jump is undone before any measurement", async () => {
        const { hook } = setup();
        vi.setSystemTime(Date.now() + 3_600_000);
        act(() => hook.result.current.start(candidates, candidates, run));
        await act(async () => {});
        vi.setSystemTime(Date.now() - 3_600_000);
        await act(async () => void serverNow());
        expect(hook.result.current.pickedFor("a", 8073)).toBeNull();
      });
    });

    // Value: protects=the context outlives the run's watch (the prompt comes a minute in) but not a hand pick; fails_when=it's dropped with the chain, or cancel keeps it so a hand-picked receiver is credited to Pick best; why_new=pick context; seam=none; no_claim=none beyond protects
    // Value (round 2 extension): protects=a hand pick counts as a drop, so a question's snapshot stays revoked even if a later run re-picks the same receiver; fails_when=cancel clears picked without drop(); why_new=only forget's count was asserted; seam=none; no_claim=the page's comparison (page test)
    it("keeps it after the watch ends, and forgets it on a hand pick", () => {
      const { hook, report } = setup();
      act(() => hook.result.current.start(candidates, candidates, run));
      report({ state: "listening", host: "a", port: 8073 });
      act(() => vi.advanceTimersByTime(WATCH_MS + 60_000));
      expect(hook.result.current.pickedFor("a", 8073)).toMatchObject({ rankPos: 0 });
      const before = hook.result.current.dropCount();
      act(() => hook.result.current.cancel());
      expect(hook.result.current.pickedFor("a", 8073)).toBeNull();
      expect(hook.result.current.dropCount()).toBe(before + 1);
    });

    // Value: protects=the receiver a failed run goes back to is never credited to this run, nor to an earlier run whose list was for another moment; fails_when=goBack's tune records context, or an earlier run's context survives the return; why_new=approach A over B (review); seam=none; no_claim=none beyond protects
    it("records nothing for the receiver it goes back to", () => {
      const { hook, report } = setup();
      // An earlier run chose "home", and it plays.
      act(() => hook.result.current.start([rx("home")], undefined, run));
      report({ state: "listening", host: "home", port: 8073 });
      act(() => vi.advanceTimersByTime(WATCH_MS));
      expect(hook.result.current.pickedFor("home", 8073)).not.toBeNull();
      // A new run fails and goes back to it.
      act(() => hook.result.current.start([rx("a")], [rx("home"), rx("a")], run));
      // Value (round 2 extension): protects=going back counts as a drop; fails_when=goBack clears picked without drop(); why_new=only forget's count was asserted; seam=none; no_claim=the page's comparison (page test)
      const before = hook.result.current.dropCount();
      report(fail("a", "busy"));
      expect(hook.result.current.note).toContain("Going back to HOME");
      expect(hook.result.current.pickedFor("home", 8073)).toBeNull();
      expect(hook.result.current.pickedFor("a", 8073)).toBeNull();
      expect(hook.result.current.dropCount()).toBe(before + 1);
    });

    // Value: protects=a beacon Listen that can't start (every candidate refused) drops the previous run's context, so it can't lend another beacon's ranking to the receiver still playing, while any other run that can't start leaves the playing receiver's still-valid choice; fails_when=start's early returns keep picked for a beacon run, or clear it for the others; why_new=adversarial review A1, narrowed in the edge-case fixes; seam=none; no_claim=a dial move, which forgetOffFrequency handles
    it.each([
      ["beacon", null],
      ["listen", { rankPos: 0 }],
      ["drawer", { rankPos: 0 }],
    ] as const)("when a %s run can't start, the last run's choice is %o", (source, expected) => {
      const { hook, report } = setup();
      act(() => hook.result.current.start([rx("a")], undefined, run));
      report({ state: "listening", host: "a", port: 8073 });
      act(() => vi.advanceTimersByTime(WATCH_MS));
      expect(hook.result.current.pickedFor("a", 8073)).not.toBeNull();
      report(fail("b", "busy"));
      // Value (round 2 extension): protects=a beacon run that can't start counts its drop, the others count none; fails_when=start's beacon branch clears picked without drop(); why_new=only forget's count was asserted; seam=none; no_claim=the page's comparison (page test)
      const before = hook.result.current.dropCount();
      let started = true;
      act(() => {
        started = hook.result.current.start([rx("b")], undefined, { source, freqKhz: 9_580 });
      });
      expect(started).toBe(false);
      if (expected) expect(hook.result.current.pickedFor("a", 8073)).toMatchObject(expected);
      else expect(hook.result.current.pickedFor("a", 8073)).toBeNull();
      expect(hook.result.current.dropCount()).toBe(before + (expected ? 0 : 1));
    });

    // Value: protects=a dial move off the frequency the run ranked for forgets its choice for good, while staying on it keeps it; fails_when=forgetOffFrequency is a no-op, clears on the same frequency, or the choice comes back with the dial; why_new=final-round review (red team); seam=none; no_claim=the page calls it on every dial move (page test)
    it("forgets its choice once the dial leaves the frequency it ranked for", () => {
      const { hook } = setup();
      act(() => hook.result.current.start(candidates, candidates, run));
      act(() => hook.result.current.forgetOffFrequency(9_580));
      expect(hook.result.current.pickedFor("a", 8073)).not.toBeNull();
      act(() => hook.result.current.forgetOffFrequency(9_590));
      act(() => hook.result.current.forgetOffFrequency(9_580));
      expect(hook.result.current.pickedFor("a", 8073)).toBeNull();
    });

    // Value: protects=a run abandoned mid-way (Stop picking with nothing to go back to, or ended by a service failure) leaves no context behind for a tune still in flight; fails_when=those finish paths keep picked, so a late-landing tune is credited to Pick best; why_new=Codex adversarial (run 4); seam=none; no_claim=the watch-phase Stop, which keeps the playing choice (tested above)
    it.each<[string, (h: ReturnType<typeof setup>) => void, number]>([
      ["Stop picking with nothing to go back to", ({ hook }) => act(() => void hook.result.current.stop()), 1],
      [
        "a service failure that ends the run",
        ({ report }) => report({ state: "error", host: "a", port: 8073, message: "listener limit" }),
        1,
      ],
      [
        "running out of receivers with nothing to go back to",
        ({ report }) => {
          for (const host of ["a", "b", "c", "d"]) report(fail(host, "busy"));
        },
        // Moves to b and c, then the drop when the run gives up (MAX_ATTEMPTS).
        3,
      ],
    ])("forgets its choice when the run is abandoned: %s", (_, abandon, dropped) => {
      // Value (round 2 extension): protects=each abandon path counts its drops: one at the end, plus one per move to another receiver; fails_when=an abandon path clears picked without drop(), or a move between candidates isn't counted; why_new=only forget's count was asserted; seam=none; no_claim=the page's comparison (page test)
      const h = setup();
      act(() => h.hook.result.current.start(candidates, candidates, run));
      expect(h.hook.result.current.pickedFor("a", 8073)).not.toBeNull();
      const before = h.hook.result.current.dropCount();
      abandon(h);
      // Not the first candidate, nor whichever one the run tuned last.
      for (const host of ["a", "b", "c", "d"]) expect(h.hook.result.current.pickedFor(host, 8073)).toBeNull();
      expect(h.hook.result.current.dropCount()).toBe(before + dropped);
    });

    // Value: protects=a new run that tunes another receiver first (it refused) and then comes back to the one a question asked about counts drops, so that question's snapshot is revoked as for a dial move away and back; fails_when=tuneCandidate replaces a choice for another receiver without counting it; why_new=round 2 review (state-machines specialist + adversarial); seam=none; no_claim=the page's comparison (page test covers the dial case)
    it("counts a run moving to another receiver and back as drops", () => {
      const { hook, report } = setup();
      act(() => hook.result.current.start([rx("a")], undefined, run));
      report({ state: "listening", host: "a", port: 8073 });
      const before = hook.result.current.dropCount();
      act(() => hook.result.current.start([rx("b"), rx("a")], undefined, run));
      report(fail("b", "busy"));
      expect(hook.result.current.pickedFor("a", 8073)).not.toBeNull();
      expect(hook.result.current.dropCount()).toBe(before + 2);
      // A run that picks the same receiver again just replaces the choice.
      act(() => hook.result.current.start([rx("a")], undefined, run));
      expect(hook.result.current.dropCount()).toBe(before + 2);
    });

    // Value: protects=Stop picking during the watch (the receiver already playing) keeps that choice, since it did play; fails_when=stop() clears picked on the watch path too; why_new=#73 proposed test 1; seam=none; no_claim=none beyond protects
    it("keeps its choice when Stop picking ends only the watch", () => {
      const { hook, report } = setup();
      act(() => hook.result.current.start(candidates, candidates, run));
      report({ state: "listening", host: "a", port: 8073 });
      act(() => void hook.result.current.stop());
      expect(hook.result.current.settled).toBe(true);
      expect(hook.result.current.pickedFor("a", 8073)).toMatchObject({ rankPos: 0 });
    });

    // Value: protects=the drop count rises when a choice is dropped (here by forget, as a beacon Listen with no list does) and not when a new run replaces it, so an answer can tell a snapshot was revoked even if the same receiver is picked again; fails_when=forget leaves the choice, the count misses a drop, or counts a replacement; why_new=round-2 edge cases (away-and-back re-pick, no-list beacon Listen); seam=none; no_claim=the page compares it (page test)
    it("counts a dropped choice, not a replaced one, and forgets on request", () => {
      const { hook, report } = setup();
      act(() => hook.result.current.start([rx("a")], undefined, run));
      report({ state: "listening", host: "a", port: 8073 });
      act(() => vi.advanceTimersByTime(WATCH_MS));
      const before = hook.result.current.dropCount();
      // A new run that picks the same receiver replaces the choice: no drop.
      act(() => hook.result.current.start([rx("a")], undefined, run));
      expect(hook.result.current.dropCount()).toBe(before);
      act(() => hook.result.current.forget());
      expect(hook.result.current.pickedFor("a", 8073)).toBeNull();
      expect(hook.result.current.dropCount()).toBe(before + 1);
      // Nothing left to drop: no count.
      act(() => hook.result.current.forget());
      expect(hook.result.current.dropCount()).toBe(before + 1);
    });

    // Value: protects=a caller that doesn't say what started the run stores no half-filled context; fails_when=start records context with an undefined source; why_new=run is optional on start; seam=none; no_claim=none beyond protects
    it("records nothing for a run started without a source", () => {
      const { hook } = setup();
      act(() => hook.result.current.start(candidates));
      expect(hook.result.current.pickedFor("a", 8073)).toBeNull();
    });
  });

  // Value: protects=a run whose candidates leave out the receiver playing (the better-receiver switch) still names it by its listed name on the way back; fails_when=start looks the fallback up only among the candidates, so the note and Back say the bare host; why_new=Claude review of the switch prompt; seam=none; no_claim=none beyond protects
  it("names the way back from the list it's given", () => {
    const { hook, report } = setup();
    report({ state: "listening", host: "home", port: 8073 });
    act(() => hook.result.current.start([rx("a")], [rx("home"), rx("a")]));
    report(fail("a", "busy"));
    expect(hook.result.current.note).toBe("Tried 1 receiver and it didn't work. Going back to HOME…");
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

  // Value: protects=Skywave's own per-receiver cap moves the run on without spending a try, so our cap alone can't end in "Tried 3 receivers and none worked" (#144); fails_when=skywave_cap counts as a strike or stops the run; why_new=the cap used to arrive as busy, a strike; seam=none; no_claim=which pages the service sends the code to (radio test_receiver_log.py)
  it("doesn't count Skywave's own per-receiver cap against the tries", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map(rx);
    const { hook, report, tuned } = setup();
    act(() => hook.result.current.start(many));
    report(fail("a", "skywave_cap"));
    expect(hook.result.current.note).toBe("A already has a Skywave listener; trying B…");
    report(fail("b", "skywave_cap"));
    report(fail("c", "busy"));
    report(fail("d", "busy"));
    // Two strikes so far: E is still tried, where four strikes-worth of busy would have stopped at C.
    expect(tuned()).toEqual(["a", "b", "c", "d", "e"]);
    report(fail("e", "busy"));
    expect(hook.result.current.note).toMatch(/Tried 5 receivers and none worked/);
  });

  // Value: protects=a candidate the service refuses while the old station plays on (a refusal, with the old station's listening status in the same render) moves the run on without a try and reports it, instead of waiting on the refused candidate for good (#144, owner D5/D8); fails_when=Pick best reads refusals only from status, or a refusal for another receiver moves the run; why_new=D8's hang came from reading the pair as statuses; seam=none (mocked track); no_claim=how use-radio builds the refusal (use-radio tests)
  it("moves on from a refused candidate even when the old station's status comes with it", () => {
    const tune = vi.fn();
    const hook = renderHook(
      ({ status, refusal }) => usePickBest(status, tune, undefined, undefined, refusal),
      {
        initialProps: {
          status: { state: "listening", host: "home.example", port: 8073 } as RadioStatus,
          refusal: null as RadioRefusal | null,
        },
      },
    );
    act(() => hook.result.current.start(candidates));
    const refusal = (seq: number, host: string): RadioRefusal => ({
      seq,
      host,
      port: 8073,
      code: "skywave_cap",
      message: "x",
      stillOn: { host: "home.example", port: 8073 },
    });
    // A refusal for a receiver the run isn't on changes nothing.
    hook.rerender({ status: { state: "listening", host: "home.example", port: 8073 }, refusal: refusal(1, "zzz") });
    expect(tune.mock.calls.map(([r]) => (r as Receiver).host)).toEqual(["a"]);
    hook.rerender({ status: { state: "listening", host: "home.example", port: 8073 }, refusal: refusal(2, "a") });
    expect(tune.mock.calls.map(([r]) => (r as Receiver).host)).toEqual(["a", "b"]);
    expect(hook.result.current.note).toBe("A already has a Skywave listener; trying B…");
    // The same refusal on a later render isn't counted twice.
    hook.rerender({ status: { state: "listening", host: "home.example", port: 8073 }, refusal: refusal(2, "a") });
    expect(tune).toHaveBeenCalledTimes(2);
  });

  // Value: protects=a Pick best run going back to where it started always ends: a way back refused while another station plays on (a "refused" message) says it couldn't get back, and a way back whose host came back lowercased reads as back; fails_when=the refusal handler ignores refusals while returning, or the way-back match is case-sensitive, so settled never turns true and the button reads checking for good; why_new=Codex outside review of 710d4a9 (owner D6); seam=none (mocked track); no_claim=whether the service can refuse the way back today
  it("ends the way back on a refusal or a lowercased host", () => {
    const tune = vi.fn();
    const hook = renderHook(
      ({ status, refusal }) => usePickBest(status, tune, undefined, undefined, refusal),
      {
        initialProps: {
          status: { state: "listening", host: "Home.Example", port: 8073 } as RadioStatus,
          refusal: null as RadioRefusal | null,
        },
      },
    );
    act(() => hook.result.current.start([rx("a")]));
    hook.rerender({ status: fail("a", "busy"), refusal: null });
    expect(hook.result.current.note).toMatch(/Going back to Home\.Example/);
    hook.rerender({
      status: { state: "listening", host: "other.example", port: 8073 },
      refusal: {
        seq: 1,
        host: "home.example",
        port: 8073,
        code: "skywave_cap",
        message: "x",
        stillOn: { host: "other.example", port: 8073 },
      },
    });
    expect(hook.result.current.note).toBe("Tried 1 receiver and it didn't work. Couldn't get back to Home.Example.");
    expect(hook.result.current.settled).toBe(true);

    // A way back answered with the host lowercased reads as back.
    hook.rerender({ status: { state: "listening", host: "Other.Example", port: 8073 }, refusal: null });
    act(() => hook.result.current.start([rx("b")]));
    hook.rerender({ status: fail("b", "busy"), refusal: null });
    hook.rerender({ status: { state: "listening", host: "other.example", port: 8073 }, refusal: null });
    expect(hook.result.current.note).toBe("Tried 1 receiver and it didn't work. Back on Other.Example.");
    expect(hook.result.current.settled).toBe(true);
  });

  // Value: protects=our cap isn't remembered as the receiver refusing, so it isn't hidden from runs for 15 minutes; fails_when=skywave_cap joins REFUSALS; why_new=new code; seam=none; no_claim=none beyond protects
  it("doesn't mark a receiver refused for Skywave's own cap", () => {
    const { hook, report } = setup();
    act(() => hook.result.current.start(candidates));
    report(fail("a", "skywave_cap"));
    expect(hook.result.current.isRefused(rx("a"))).toBe(false);
  });

  describe("pick_best_end", () => {
    beforeEach(() => {
      track.mockClear();
      vi.useFakeTimers();
    });
    afterEach(() => vi.useRealTimers());
    const ends = () => track.mock.calls.filter(([name]) => name === "pick_best_end").map(([, props]) => props);

    // Value: protects=one run-end event per Pick best run, saying whether it played or gave up and which codes moved it on, in order (#144 D6); fails_when=the event is missing, sent twice, or the codes are wrong or out of order; why_new=only per-error events existed; seam=none (mocked track); no_claim=Vercel ingestion
    it("reports a run that gives up, once, with its codes in order", () => {
      const { hook, report } = setup();
      act(() => hook.result.current.start(candidates));
      report(fail("a", "skywave_cap"));
      report(fail("b", "busy"));
      report(fail("c", "unreachable"));
      report(fail("d", "busy"));
      expect(ends()).toEqual([{ outcome: "gave_up", codes: "skywave_cap,busy,unreachable,busy" }]);
      report({ state: "idle" });
      expect(ends()).toHaveLength(1);
    });

    // Value: protects=a run cut short by the tab closing still sends its pick_best_end and radio_refused, once (a closing tab never unmounts); fails_when=only finish, Stop, a new run or unmount report, or pagehide and the later unmount both send; why_new=owner asked about runs cut short on busy evenings; seam=a dispatched pagehide event (mocked track); no_claim=that the browser delivers the beacon while the tab closes
    it("reports a run cut short by the tab closing, once", () => {
      // Hooks earlier tests left mounted would hear the same pagehide.
      cleanup();
      track.mockClear();
      const sent = (name: string) => track.mock.calls.filter(([n]) => n === name).map(([, props]) => props);
      const { hook, report } = setup();
      act(() => hook.result.current.start(candidates));
      report(fail("a", "skywave_cap"));
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(sent("pick_best_end")).toEqual([{ outcome: "stopped", codes: "skywave_cap" }]);
      expect(sent("radio_refused")).toEqual([{ code: "skywave_cap", receivers: 1, source: "pick_best" }]);
      hook.unmount();
      expect(sent("pick_best_end")).toHaveLength(1);
      expect(sent("radio_refused")).toHaveLength(1);
    });

    // Value: protects=a Pick best run that meets Skywave's own cap sends one radio_refused at its end with how many receivers it met, not one per receiver, and a run that met none sends none (owner, final review); fails_when=the count is missing or per receiver, or a run without skywave_cap sends one; why_new=radio_refused split from radio_error; seam=none (mocked track); no_claim=Vercel ingestion
    it("sends one radio_refused per run with the number of capped receivers", () => {
      const refusals = () => track.mock.calls.filter(([name]) => name === "radio_refused").map(([, props]) => props);
      const { hook, report } = setup();
      act(() => hook.result.current.start(candidates));
      report(fail("a", "skywave_cap"));
      report(fail("b", "busy"));
      report(fail("c", "skywave_cap"));
      expect(refusals()).toEqual([]);
      report({ state: "listening", host: "d", port: 8073 });
      act(() => vi.advanceTimersByTime(WATCH_MS));
      expect(refusals()).toEqual([{ code: "skywave_cap", receivers: 2, source: "pick_best" }]);
      track.mockClear();
      act(() => hook.result.current.start(candidates));
      report(fail("a", "busy"));
      report({ state: "listening", host: "b", port: 8073 });
      act(() => vi.advanceTimersByTime(WATCH_MS));
      expect(refusals()).toEqual([]);
    });

    it("reports a run that played once its watch ends, codes and all", () => {
      const { hook, report } = setup();
      act(() => hook.result.current.start(candidates));
      report(fail("a", "busy"));
      report({ state: "listening", host: "b", port: 8073 });
      expect(ends()).toEqual([]);
      act(() => vi.advanceTimersByTime(WATCH_MS));
      expect(ends()).toEqual([{ outcome: "played", codes: "busy" }]);
    });

    it("reports a run that plays first time with no codes", () => {
      const { hook, report } = setup();
      act(() => hook.result.current.start(candidates));
      report({ state: "listening", host: "a", port: 8073 });
      act(() => hook.result.current.cancel());
      expect(ends()).toEqual([{ outcome: "played", codes: null }]);
    });

    it("reports a run stopped mid-way, and one the service failed", () => {
      const first = setup();
      act(() => first.hook.result.current.start(candidates));
      first.report(fail("a", "busy"));
      act(() => {
        first.hook.result.current.stop();
      });
      const second = setup();
      act(() => second.hook.result.current.start(candidates));
      second.report({ state: "error", message: "Lost the connection to the radio service." });
      expect(ends()).toEqual([
        { outcome: "stopped", codes: "busy" },
        { outcome: "service", codes: null },
      ]);
    });

    // Value: protects=during the watch, a late refusal is not reported as played (the run goes on and reports once at its real end), while a drop or a Stop reports played; fails_when=the watch's refusal path reports played early, or its other-status or Stop paths report nothing or stopped; why_new=pick_best_end tests covered the watch only via its timer and cancel; seam=none (mocked track); no_claim=Vercel ingestion
    it.each([
      ["a late refusal, then the run gives up", "refusal", { outcome: "gave_up", codes: "no_apps,busy,busy" }],
      ["a drop", "drop", { outcome: "played", codes: null }],
      ["Stop picking", "stop", { outcome: "played", codes: null }],
    ] as const)("reports a watch ended by %s", (_, how, end) => {
      const { hook, report } = setup();
      act(() => hook.result.current.start(candidates));
      report({ state: "listening", host: "a", port: 8073 });
      if (how === "refusal") {
        report(fail("a", "no_apps"));
        expect(ends()).toEqual([]);
        for (const host of ["b", "c"]) report(fail(host, "busy"));
      } else if (how === "drop") {
        report({ state: "error", message: "Lost the connection to the radio service." });
      } else {
        act(() => {
          hook.result.current.stop();
        });
      }
      expect(ends()).toEqual([end]);
    });

    // Value: protects=a run still being watched or running when a new Pick best can't begin (nothing covers the dial, or every receiver refused) still sends its one pick_best_end (owner D3); fails_when=start()'s early returns drop the old chain unreported; why_new=only a start that begins was covered; seam=none (mocked track); no_claim=Vercel ingestion
    it.each<[string, Receiver[]]>([
      ["nothing covers the dial", []],
      ["every receiver refused", [rx("a")]],
    ])("reports the old run when a new one can't begin (%s)", (_, covering) => {
      const { hook, report } = setup();
      act(() => hook.result.current.start(candidates));
      report(fail("a", "busy"));
      report({ state: "listening", host: "b", port: 8073 });
      act(() => {
        hook.result.current.start(covering);
      });
      expect(ends()).toEqual([{ outcome: "played", codes: "busy" }]);
    });

    // Value: protects=leaving the page during the watch reports the run that played (owner D3); fails_when=the unmount cleanup only clears timers; why_new=unmount wasn't covered; seam=none (mocked track); no_claim=Vercel delivering an event from a closing page
    it("reports a watched run when the page unmounts, once", () => {
      const { hook, report } = setup();
      act(() => hook.result.current.start(candidates));
      report({ state: "listening", host: "a", port: 8073 });
      hook.unmount();
      expect(ends()).toEqual([{ outcome: "played", codes: null }]);
      act(() => vi.advanceTimersByTime(WATCH_MS));
      expect(ends()).toHaveLength(1);
    });

    it("reports the old run when Pick best starts again", () => {
      const { hook, report } = setup();
      act(() => hook.result.current.start(candidates));
      report(fail("a", "busy"));
      act(() => hook.result.current.start(candidates.slice(1)));
      expect(ends()).toEqual([{ outcome: "stopped", codes: "busy" }]);
    });
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

describe("usePickBest with held receivers", () => {
  // Value: protects=a run tries receivers another Skywave listener holds last, not first and not never, so it doesn't spend its MAX_TOTAL walking past ones the service will refuse (skywave_cap) and still reaches them if the rest fail; fails_when=held receivers keep their rank, are dropped outright, or the order of the free ones changes; why_new=#155: 701 skywave_cap refusals a day; seam=isHeld injected; no_claim=how fresh the held answer is
  it("tries held receivers last", () => {
    const tune = vi.fn();
    const hook = renderHook(
      ({ status }) => usePickBest(status, tune, undefined, undefined, null, (r) => r.host === "a" || r.host === "c"),
      { initialProps: { status: { state: "idle" } as RadioStatus } },
    );
    act(() => hook.result.current.start(candidates));
    hook.rerender({ status: fail("b", "busy") });
    hook.rerender({ status: fail("d", "busy") });
    expect(tune.mock.calls.map(([r]) => (r as Receiver).host)).toEqual(["b", "d", "a"]);
  });

  // Value: protects=the receiver this page is playing isn't pushed back as held (it's held by this listener), so Pick best on it retunes in place instead of switching away; fails_when=the playing receiver is demoted like another listener's; why_new=/held counts this page's own session; seam=isHeld injected; no_claim=none
  it("keeps the receiver this page plays in its place", () => {
    const tune = vi.fn();
    const hook = renderHook(({ status }) => usePickBest(status, tune, undefined, undefined, null, () => true), {
      initialProps: { status: { state: "listening", host: "a", port: 8073 } as RadioStatus },
    });
    act(() => hook.result.current.start(candidates));
    expect(tune.mock.calls.map(([r]) => (r as Receiver).host)).toEqual(["a"]);
  });

  // Value: protects=only a live session (listening or connecting) is this page's own: a receiver still connecting keeps its place, while one that errored or stopped is demoted like another listener's, since this page no longer holds it; fails_when=connecting is left out of `live`, or any status with a host counts as this page's; why_new=the other test covers listening only; seam=isHeld injected; no_claim=what the service counts for a connecting session
  it.each([
    { status: { state: "connecting", host: "a", port: 8073 } as RadioStatus, first: "a" },
    // "down", not a refusal code: a refusal would drop "a" from the run whatever the live rule says.
    { status: fail("a", "down"), first: "b" },
    { status: { state: "stopped", host: "a", port: 8073 } as RadioStatus, first: "b" },
  ])("treats a $status.state session on the held receiver as this page's only while it's live", ({ status, first }) => {
    const tune = vi.fn();
    const hook = renderHook(
      ({ status }) => usePickBest(status, tune, undefined, undefined, null, (r) => r.host === "a"),
      { initialProps: { status } },
    );
    act(() => hook.result.current.start(candidates));
    expect((tune.mock.calls[0]![0] as Receiver).host).toBe(first);
  });
});
