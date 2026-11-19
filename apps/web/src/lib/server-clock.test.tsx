// @vitest-environment jsdom
import { useQuery } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beaconOnBand } from "./ibp";
import {
  DATE_HEADER_ROUNDING_MS,
  MAX_ROUND_TRIP_MS,
  noteResponse,
  onServerOffset,
  JUMP_MS,
  REMEASURE_MS,
  REMEASURE_PATH,
  REMEASURE_RETRY_MS,
  REMEASURE_ROUND_TRIP_MS,
  offsetFromResponse,
  resetServerClock,
  serverClockSettled,
  serverNow,
  serverOffset,
} from "./server-clock";
import { Providers, useTRPC } from "./trpc";

const headers = (h: Record<string, string>) => new Headers(h);

// The true time: 12:00:12.000 UTC, two seconds after the beacons changed bands.
const TRUE_MS = Date.UTC(2026, 10, 18, 12, 0, 12);
// This browser's clock runs 5 s slow.
const SKEW_MS = -5_000;

beforeEach(() => resetServerClock());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("offsetFromResponse", () => {
  // Value: protects=the offset reads the Date header against the middle of the round trip, with the header's dropped milliseconds put back; fails_when=it uses the send or receive time alone, or forgets the rounding; why_new=server clock; seam=none; no_claim=network asymmetry
  it("measures the server's lead from the Date header and the round trip", () => {
    const sent = TRUE_MS + SKEW_MS - 200;
    const received = TRUE_MS + SKEW_MS + 200;
    // The server stamped 12:00:12 (it was really 12:00:12.000–.999).
    const o = offsetFromResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), sent, received);
    expect(o).toBe(-SKEW_MS + DATE_HEADER_ROUNDING_MS);
  });

  // Value: protects=a cached response, a missing or bad header, or a slow round trip never sets the clock; fails_when=any of them is trusted; why_new=server clock; seam=none; no_claim=none
  it("ignores responses it can't trust", () => {
    const date = new Date(TRUE_MS).toUTCString();
    expect(offsetFromResponse(headers({}), 0, 10)).toBeNull();
    expect(offsetFromResponse(headers({ date: "not a date" }), 0, 10)).toBeNull();
    expect(offsetFromResponse(headers({ date, age: "120" }), 0, 10)).toBeNull();
    expect(offsetFromResponse(headers({ date }), 0, MAX_ROUND_TRIP_MS + 1)).toBeNull();
    expect(offsetFromResponse(headers({ date, age: "0" }), TRUE_MS, TRUE_MS)).not.toBeNull();
  });
});

describe("serverNow", () => {
  // Value: protects=a browser clock 5 s off still names the beacon on the air (issue #59's gotcha), and only the first usable response sets the offset; fails_when=the IBP math uses the raw clock, or a later response moves it; why_new=server clock; seam=fake system time; no_claim=sub-second accuracy
  it("corrects a 5-second skew so the right beacon is named", () => {
    vi.useFakeTimers({ now: TRUE_MS + SKEW_MS });
    // Uncorrected, the slow clock names the beacon from the slot before.
    expect(beaconOnBand(Date.now(), 0).call).not.toBe(beaconOnBand(TRUE_MS, 0).call);

    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    expect(Math.abs(serverNow() - TRUE_MS)).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS);
    expect(beaconOnBand(serverNow(), 0).call).toBe(beaconOnBand(TRUE_MS, 0).call);

    // A later response doesn't move it.
    const first = serverOffset();
    noteResponse(headers({ date: new Date(TRUE_MS + 60_000).toUTCString() }), Date.now(), Date.now());
    expect(serverOffset()).toBe(first);
  });

  // Value: protects=setting the computer's clock back (by hand or an NTP step; a sleep can't do that) doesn't move the server time the page works from, and the next response doesn't re-plan anything; fails_when=serverNow is tied to Date.now again, or a steady offset is replaced after the jump; why_new=clock TODO (owner: monotonic clock + re-plan); seam=fake timers (setSystemTime moves only Date); no_claim=browsers whose monotonic clock pauses in sleep (next test)
  it("ignores the computer's clock being set back", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    const told = vi.fn();
    const off = onServerOffset(told);
    const before = serverNow();
    vi.setSystemTime(Date.now() - 3_600_000);
    expect(serverNow()).toBe(before);
    vi.advanceTimersByTime(1_000);
    noteResponse(headers({ date: new Date(TRUE_MS + 1_000).toUTCString() }), Date.now() - 100, Date.now());
    expect(told).not.toHaveBeenCalled();
    expect(Math.abs(serverNow() - (TRUE_MS + 1_000))).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS);
    // Value (extension): protects=a measurement after a jump that keeps the offset still ends the jump, so later quick responses are ignored again; fails_when=the jump is marked measured only when the offset is replaced; why_new=no test sent a response after the small re-measure; seam=fake timers; no_claim=none beyond protects
    const kept = serverOffset();
    vi.advanceTimersByTime(1_000);
    noteResponse(headers({ date: new Date(TRUE_MS + 2_000 + 3 * REMEASURE_MS).toUTCString() }), Date.now() - 100, Date.now());
    expect(told).not.toHaveBeenCalled();
    expect(serverOffset()).toBe(kept);
    off();
  });

  // Value: protects=after a sleep the monotonic clock lagged through, the page's server time is right at once (the computer's clock kept time), listeners hear of the switch, the clock reads as unsettled until a quick response (never a slow one or one without a Date header) re-measures, and the re-measure keeps the right time without telling anyone again; fails_when=the time lags by the sleep until a response, the switch is silent, a slow or headerless response closes the jump, or the re-measure moves or re-announces a right time; why_new=clock TODO (owner: monotonic clock + re-plan) and the clock-edges TODO (owner: core set); seam=fake timers (setSystemTime models the wall clock moving on while performance.now paused); no_claim=network asymmetry
  it("measures again after a sleep, from a quick response only", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    const told = vi.fn();
    const off = onServerOffset(told);
    expect(serverClockSettled()).toBe(true);
    // Ten minutes asleep: the wall clock and the server moved on, performance.now() didn't.
    const woke = TRUE_MS + 600_000;
    vi.setSystemTime(woke);
    expect(Math.abs(serverNow() - woke)).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS);
    expect(serverClockSettled()).toBe(false);
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(Math.abs(serverNow() - (woke + 1_000))).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS);
    noteResponse(headers({ date: new Date(woke).toUTCString() }), Date.now() - REMEASURE_ROUND_TRIP_MS - 1, Date.now());
    noteResponse(headers({}), Date.now() - 100, Date.now());
    expect(serverClockSettled()).toBe(false);
    noteResponse(headers({ date: new Date(woke + 1_000).toUTCString() }), Date.now() - 100, Date.now());
    expect(serverClockSettled()).toBe(true);
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(1);
    expect(Math.abs(serverNow() - (woke + 1_000))).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS + 50);
    // Measured again, the offset holds until the next jump.
    const kept = serverOffset();
    vi.advanceTimersByTime(1_000);
    noteResponse(headers({ date: new Date(woke + 2_000 + 3 * REMEASURE_MS).toUTCString() }), Date.now() - 100, Date.now());
    expect(told).toHaveBeenCalledTimes(1);
    expect(serverOffset()).toBe(kept);
    off();
  });

  // Value: protects=a re-measure within REMEASURE_MS of the time shown keeps that time, so a short (2-3 s) sleep never snaps back onto the lagging monotonic clock and leftover error can't pile up across jumps (drifts of 2.5 s then 1.9 s stay under JUMP_MS of the true time, not ~4.4 s); fails_when=the re-measure compares with the old offset instead of the time shown; why_new=clock-edges TODO (adversarial review: pile-up); seam=fake timers (setSystemTime moves only Date, as a monotonic clock lagging the true one); no_claim=real drift rates between performance.now and Date.now
  it("keeps the time shown at a re-measure, so error doesn't pile up across jumps", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    // The monotonic clock falls 2.5 s behind the true time (the computer's clock).
    vi.setSystemTime(Date.now() + 2_500);
    const truth = Date.now();
    expect(Math.abs(serverNow() - truth)).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS);
    // A quick response measuring the true time 0.6 s short (header rounding and an
    // uneven 0.8 s round trip): 1.9 s from the old offset, 0.6 s from the time shown.
    noteResponse(headers({ date: new Date(TRUE_MS + 1_000).toUTCString() }), Date.now() - 800, Date.now());
    expect(Math.abs(serverNow() - truth)).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS);
    // Another 1.9 s, under JUMP_MS: no re-measure, but the error doesn't stack on the first.
    vi.setSystemTime(Date.now() + 1_900);
    expect(Date.now() - serverNow()).toBeLessThan(JUMP_MS);
  });

  // Value: protects=a small forward change by hand (2.2 s, just past JUMP_MS) is corrected at the re-measure: the measurement agrees with the old offset, not the time shown, so the old offset stays and listeners hear the time move back; fails_when=the re-measure keeps the time shown whenever it's within REMEASURE_MS of the measurement (round 3's first rule); why_new=round 3 adversarial review (owner D3); seam=fake timers (setSystemTime moves only Date); no_claim=network asymmetry
  it("corrects a small forward change by hand", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    const told = vi.fn();
    const off = onServerOffset(told);
    // 2.2 s forward by hand: the server didn't move.
    vi.setSystemTime(Date.now() + 2_200);
    expect(serverNow() - TRUE_MS).toBeGreaterThan(2_000);
    // A quick response with an uneven 0.8 s round trip: 1.8 s from the time shown
    // (within REMEASURE_MS), 0.4 s from the old offset, which is the one it agrees with.
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now() - 800, Date.now());
    expect(Math.abs(serverNow() - TRUE_MS)).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS + 50);
    expect(told).toHaveBeenCalled();
    off();
  });

  // Value: protects=while on the computer's clock the page asks the server again every REMEASURE_RETRY_MS until a response lands (a lost or slow first one doesn't leave an idle tab on the wrong clock), never more often, and stops once measured; fails_when=the re-measure is one-shot, retries on every serverNow call, or keeps asking after the clock settles; why_new=round 3 Codex adversarial (owner D3); seam=stubbed fetch, fake timers; no_claim=the deployed route's latency
  it("asks again every REMEASURE_RETRY_MS until the clock is measured", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    let answer = false;
    const fetch = vi.fn(async () => {
      if (!answer) throw new TypeError("offline");
      return new Response(null, { status: 204, headers: { date: new Date(Date.now() - 3_600_000).toUTCString() } });
    });
    vi.stubGlobal("fetch", fetch);
    vi.setSystemTime(Date.now() + 3_600_000);
    serverNow();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REMEASURE_RETRY_MS - 1);
    serverNow();
    expect(fetch).toHaveBeenCalledTimes(1);
    answer = true;
    vi.advanceTimersByTime(1);
    serverNow();
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(serverClockSettled()).toBe(true));
    vi.advanceTimersByTime(REMEASURE_RETRY_MS);
    serverNow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // Value: protects=once on the computer's clock the page stays there until the drift falls under LEAVE_WALL_CLOCK_MS, so jitter at JUMP_MS can't flap between the clocks (each flap re-plans the question and drops picks), and a response is still taken inside that band; fails_when=the switch back uses the same threshold as the switch in, or noteResponse ignores responses while the drift is under JUMP_MS on the computer's clock; why_new=round 3 adversarial review (owner D3); seam=fake timers (setSystemTime moves only Date); no_claim=real clock jitter
  it("doesn't flap between clocks at the edge", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    const told = vi.fn();
    const off = onServerOffset(told);
    vi.setSystemTime(Date.now() + JUMP_MS + 100);
    serverNow();
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(1);
    expect(serverClockSettled()).toBe(false);
    // Jitter back under JUMP_MS but not under LEAVE_WALL_CLOCK_MS: still on the computer's clock.
    vi.setSystemTime(Date.now() - 300);
    serverNow();
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(1);
    expect(serverClockSettled()).toBe(false);
    // A quick response inside that band still measures and settles it.
    noteResponse(headers({ date: new Date(Date.now()).toUTCString() }), Date.now() - 100, Date.now());
    expect(serverClockSettled()).toBe(true);
    off();
  });

  // Value: protects=a re-measure that moves the time by less than REMEASURE_MS still tells listeners (a 2.1 s step by hand, then 0.5 s back, corrected inside the 1-2 s band), so a pick or question planned on the wrong time is dropped or re-planned; fails_when=only moves over REMEASURE_MS notify; why_new=round 3 scoped fix-check (owner D4); seam=fake timers (setSystemTime moves only Date); no_claim=network asymmetry
  it("tells listeners of a correction inside the 1-2 s band", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    const told = vi.fn();
    const off = onServerOffset(told);
    vi.setSystemTime(Date.now() + 2_100);
    serverNow();
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(1);
    // Half a second back by hand: 1.6 s ahead, still on the computer's clock.
    vi.setSystemTime(Date.now() - 500);
    serverNow();
    expect(serverClockSettled()).toBe(false);
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now() - 100, Date.now());
    expect(Math.abs(serverNow() - TRUE_MS)).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS + 50);
    expect(told).toHaveBeenCalledTimes(2);
    off();
  });

  // Value: protects=a re-measure after the computer's clock was set back keeps the time and tells no one, even though serverNow() and noteResponse read performance.now() microseconds apart, so a planned beacon question isn't re-planned for nothing; fails_when=noteResponse notifies on any difference between the kept offset and the time shown; why_new=round 3 scoped fix-check (owner D5); seam=fake timers, performance.now() spied to advance 10 µs per read; no_claim=real clock resolution
  it("stays quiet when a re-measure after a clock set back keeps the time", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    const told = vi.fn();
    const off = onServerOffset(told);
    vi.setSystemTime(Date.now() - 3_000);
    let t = performance.now();
    const now = vi.spyOn(performance, "now").mockImplementation(() => (t += 0.01));
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now() - 100, Date.now());
    now.mockRestore();
    expect(told).not.toHaveBeenCalled();
    off();
  });

  // Value: protects=after a re-measure lands, the next jump asks the server at once rather than waiting out REMEASURE_RETRY_MS from the last ask; fails_when=the retry clock isn't reset when the clock settles; why_new=round 3 scoped fix-check (owner D4); seam=stubbed fetch, fake timers; no_claim=none beyond protects
  it("asks at once on a second jump soon after a re-measure", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    const fetch = vi.fn(async () => new Response(null, { status: 204, headers: { date: new Date(TRUE_MS).toUTCString() } }));
    vi.stubGlobal("fetch", fetch);
    vi.setSystemTime(Date.now() + 3_600_000);
    serverNow();
    await vi.waitFor(() => expect(serverClockSettled()).toBe(true));
    vi.advanceTimersByTime(1_000);
    vi.setSystemTime(Date.now() + 3_600_000);
    serverNow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // Value: protects=listeners hear when serverNow() switches to the computer's clock (a forward jump) and back (the jump undone before any response), after the caller has its value, so the beacon question never keeps a plan made on the other clock; fails_when=only a re-measure notifies, or the switch notifies synchronously inside serverNow; why_new=clock-edges TODO (adversarial review: silent switch); seam=fake timers (setSystemTime moves only Date); no_claim=none beyond protects
  it("tells listeners when it switches clocks, even with no response", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    const told = vi.fn();
    const off = onServerOffset(told);
    vi.setSystemTime(Date.now() + 60_000);
    serverNow();
    expect(told).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() - 60_000);
    expect(Math.abs(serverNow() - TRUE_MS)).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS);
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(2);
    off();
  });

  // Value: protects=a response that closes a jump nothing had read yet still tells listeners the time moved onto the computer's clock, and a settled clock then stays silent (no stray switch notice); fails_when=noteResponse notifies only on a correction, or it leaves the wall-clock flag set so the next serverNow announces a switch back; why_new=existing jump tests all call serverNow before the response; seam=fake timers (setSystemTime moves only Date); no_claim=none beyond protects
  it("tells listeners once when a response is the first to see a jump", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    const told = vi.fn();
    const off = onServerOffset(told);
    // Ten minutes asleep, and nothing read the clock before the next response.
    const woke = TRUE_MS + 600_000;
    vi.setSystemTime(woke);
    noteResponse(headers({ date: new Date(woke).toUTCString() }), Date.now() - 100, Date.now());
    expect(told).toHaveBeenCalledTimes(1);
    expect(serverClockSettled()).toBe(true);
    expect(Math.abs(serverNow() - woke)).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS + 50);
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(1);
    off();
  });

  // Value: protects=a switch onto the computer's clock sends one HEAD to /api/trpc through the clock's own fetch, so the next measurement comes within a round trip rather than with the next answer: a change by hand is corrected before anything recorded on the wrong time is sent; fails_when=the switch only notifies, or every serverNow call sends a request; why_new=owner D1 in round 3's review (re-measure on a switch); seam=stubbed fetch, fake timers (setSystemTime moves only Date); no_claim=the deployed route's status (any response carries a Date header)
  it("measures again at once when it switches to the computer's clock", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    const fetch = vi.fn(async () => new Response(null, { status: 405, headers: { date: new Date(TRUE_MS).toUTCString() } }));
    vi.stubGlobal("fetch", fetch);
    // An hour forward by hand: the server didn't move.
    vi.setSystemTime(Date.now() + 3_600_000);
    serverNow();
    serverNow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(REMEASURE_PATH, expect.objectContaining({ method: "HEAD" }));
    await vi.waitFor(() => expect(serverClockSettled()).toBe(true));
    // Corrected back from an hour ahead (waitFor's own ticks moved the clock a little).
    expect(Math.abs(serverNow() - TRUE_MS)).toBeLessThan(REMEASURE_MS);
  });

  // Value: protects=a listener that throws neither fails the response that measured the clock (a tRPC call) nor keeps the other listeners from hearing; fails_when=listeners run bare inside noteResponse; why_new=clock-edges TODO (adversarial review); seam=console.error spied; no_claim=none beyond protects
  it("keeps measuring when a listener throws", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const offBad = onServerOffset(() => {
      throw new Error("boom");
    });
    const told = vi.fn();
    const off = onServerOffset(told);
    expect(() => noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now())).not.toThrow();
    expect(told).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    offBad();
    off();
  });

  // Value: protects=setting the computer's clock forward by hand (it looks like a sleep until the server answers) is corrected by the next quick response, and listeners are told because the time the page showed moved though the offset was kept; fails_when=closing the jump keeps the offset silently, so the beacon strip and the planned question split; why_new=review of the sleep fallback; seam=fake timers (setSystemTime moves only Date); no_claim=network asymmetry
  it("corrects the computer's clock being set forward at the next quick response", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    const told = vi.fn();
    const off = onServerOffset(told);
    // An hour forward by hand: the server didn't move, and neither did performance.now().
    vi.setSystemTime(Date.now() + 3_600_000);
    expect(serverNow() - TRUE_MS).toBeGreaterThan(3_000_000);
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now() - 100, Date.now());
    expect(told).toHaveBeenCalledTimes(1);
    expect(Math.abs(serverNow() - TRUE_MS)).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS + 50);
    off();
  });

  // Value: protects=on an ordinary visit (no jump) a first offset from a slow response is kept even when a quick later one disagrees by more than REMEASURE_MS, so the clock never moves under the beacon strip; fails_when=any quick response may replace the offset without a jump (the pulled re-measure's bug); why_new=PR #74 red team; seam=fake timers; no_claim=the first offset's accuracy, which is as before
  it("keeps a slow first offset on an ordinary visit", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    // The first response took 4.8 s, and the server stamped it right as it was sent.
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now() + 4_800);
    const first = serverOffset();
    const told = vi.fn();
    const off = onServerOffset(told);
    vi.advanceTimersByTime(30_000);
    noteResponse(headers({ date: new Date(TRUE_MS + 30_000).toUTCString() }), Date.now() - 50, Date.now());
    expect(told).not.toHaveBeenCalled();
    expect(serverOffset()).toBe(first);
    off();
  });

  // Value: protects=before any response, the page's own clock is used rather than nothing; fails_when=serverNow throws or returns NaN with no offset; why_new=server clock; seam=fake system time; no_claim=none
  it("falls back to this browser's clock until a response arrives", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    expect(serverOffset()).toBeNull();
    expect(serverNow()).toBe(TRUE_MS);
  });
});

function AQuery() {
  const trpc = useTRPC();
  useQuery(trpc.presets.list.queryOptions());
  return null;
}

// Value: protects=the re-measure path reaches the tRPC route handler (app/api/trpc/[trpc]), which answers every request fresh, not a bare /api/trpc that matches no route and can be served a cached not-found page with an Age header the clock refuses; fails_when=REMEASURE_PATH points anywhere but under /api/trpc/ or the route moves; why_new=round 3 fix-check (owner: fix the path); seam=none (reads the route file); no_claim=what Vercel's edge does with the handler's 204 (checked with curl on the preview)
it("re-measures through the tRPC route handler", async () => {
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  expect(REMEASURE_PATH).toMatch(/^\/api\/trpc\/[a-z]+$/);
  expect(existsSync(resolve(__dirname, "../app/api/trpc/[trpc]/route.ts"))).toBe(true);
});

// Value: protects=the tRPC client really reads the server's Date header (the wiring, not just the math); fails_when=Providers stops passing clockedFetch to its links; why_new=server clock; seam=stubbed fetch; no_claim=that Vercel sends a Date header (HTTP requires one)
it("takes the server's time from a tRPC response", async () => {
  const serverDate = new Date(Date.now() + 5_000 - (Date.now() % 1000)).toUTCString();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { status: 500, headers: { date: serverDate } })),
  );
  render(
    <Providers>
      <AQuery />
    </Providers>,
  );
  await waitFor(() => expect(serverOffset()).not.toBeNull());
  expect(serverOffset()!).toBeGreaterThan(3_500);
  expect(serverOffset()!).toBeLessThan(6_000);
});
