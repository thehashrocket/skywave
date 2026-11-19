// @vitest-environment jsdom
import { useQuery } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beaconOnBand } from "./ibp";
import {
  DATE_HEADER_ROUNDING_MS,
  JUMP_MS,
  MAX_ROUND_TRIP_MS,
  MIN_CORRECTION_MS,
  ORDINARY_CORRECTION_MS,
  REMEASURE_BACKOFF_MS,
  REMEASURE_EVERY_MS,
  REMEASURE_PATH,
  REMEASURE_RETRY_MS,
  REMEASURE_TIMEOUT_MS,
  SERVER_MS_HEADER,
  VISIBLE_REMEASURE_MS,
  measureFromResponse,
  noteResponse,
  offsetFromResponse,
  onServerOffset,
  resetServerClock,
  serverClockCorrections,
  clockedFetch,
  serverClockSettled,
  serverNow,
  serverOffset,
  settleServerClock,
} from "./server-clock";
import { Providers, useTRPC } from "./trpc";

const headers = (h: Record<string, string>) => new Headers(h);
const precise = (serverMs: number) => headers({ [SERVER_MS_HEADER]: String(serverMs) });

// The true time: 12:00:12.000 UTC, two seconds after the beacons changed bands.
const TRUE_MS = Date.UTC(2026, 10, 18, 12, 0, 12);
// This browser's clock runs 5 s slow.
const SKEW_MS = -5_000;

/** A response stamped with the server's true time `trueNow` (as of now), after a `roundTrip` ms round trip. */
const reply = (trueNow: number, roundTrip = 0) =>
  noteResponse(precise(trueNow - roundTrip / 2), Date.now() - roundTrip, Date.now());

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

/** A fetch whose HEAD answers fresh with the server's time, `server()` at the moment it answers. */
const answering = (server: () => number) =>
  vi.fn(async () => new Response(null, { status: 204, headers: { [SERVER_MS_HEADER]: String(server()) } }));

beforeEach(() => {
  resetServerClock();
  visibility = "visible";
});
afterEach(() => {
  cleanup();
  resetServerClock();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("measureFromResponse", () => {
  // Value: protects=the server's ms header is read against the middle of the round trip and is good to half of it; fails_when=it uses the send or receive time alone, or claims a smaller error; why_new=ms precision (owner, scheduled-clock round); seam=none; no_claim=network asymmetry
  it("reads the ms header against the middle of the round trip", () => {
    const sent = TRUE_MS + SKEW_MS - 200;
    const received = TRUE_MS + SKEW_MS + 200;
    expect(measureFromResponse(precise(TRUE_MS), sent, received)).toEqual({ offset: -SKEW_MS, error: 200 });
  });

  // Value: protects=without a usable ms header the Date header still measures, with its dropped milliseconds put back and its half-second counted in the error; fails_when=the fallback is lost (the password gate's 401 carries no ms header) or forgets the rounding; why_new=server clock; seam=none; no_claim=network asymmetry
  it("falls back to the Date header", () => {
    const sent = TRUE_MS + SKEW_MS - 200;
    const received = TRUE_MS + SKEW_MS + 200;
    const date = new Date(TRUE_MS).toUTCString();
    const expected = { offset: -SKEW_MS + DATE_HEADER_ROUNDING_MS, error: DATE_HEADER_ROUNDING_MS + 200 };
    expect(measureFromResponse(headers({ date }), sent, received)).toEqual(expected);
    expect(measureFromResponse(headers({ date, [SERVER_MS_HEADER]: "nope" }), sent, received)).toEqual(expected);
    expect(offsetFromResponse(headers({ date }), sent, received)).toBe(expected.offset);
  });

  // Value: protects=a cached response, a missing or bad header, or a slow or backwards round trip never measures; fails_when=any of them is trusted; why_new=server clock; seam=none; no_claim=none
  it("ignores responses it can't trust", () => {
    const date = new Date(TRUE_MS).toUTCString();
    expect(measureFromResponse(headers({}), 0, 10)).toBeNull();
    expect(measureFromResponse(headers({ date: "not a date" }), 0, 10)).toBeNull();
    expect(measureFromResponse(headers({ date, age: "120" }), 0, 10)).toBeNull();
    expect(measureFromResponse(precise(TRUE_MS), 0, MAX_ROUND_TRIP_MS + 1)).toBeNull();
    expect(measureFromResponse(precise(TRUE_MS), 10, 0)).toBeNull();
    expect(measureFromResponse(headers({ date, age: "0" }), TRUE_MS, TRUE_MS)).not.toBeNull();
  });
});

describe("serverNow", () => {
  // Value: protects=before any response the page's own clock is used and the clock reads as unsettled; fails_when=serverNow throws or returns NaN with no offset, or a pick before the first measurement counts as settled; why_new=server clock, round 3 final review; seam=fake system time; no_claim=none
  it("falls back to this browser's clock, unsettled, until a response arrives", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    expect(serverOffset()).toBeNull();
    expect(serverNow()).toBe(TRUE_MS);
    expect(serverClockSettled()).toBe(false);
  });

  // Value: protects=a browser clock 5 s off still names the beacon on the air (issue #59's gotcha) from the first response, and listeners hear of it; fails_when=the IBP math uses the raw clock; why_new=server clock; seam=fake timers; no_claim=none
  it("corrects a 5-second skew so the right beacon is named", () => {
    vi.useFakeTimers({ now: TRUE_MS + SKEW_MS });
    const told = vi.fn();
    onServerOffset(told);
    expect(beaconOnBand(Date.now(), 0).call).not.toBe(beaconOnBand(TRUE_MS, 0).call);
    reply(TRUE_MS);
    expect(serverNow()).toBe(TRUE_MS);
    expect(beaconOnBand(serverNow(), 0).call).toBe(beaconOnBand(TRUE_MS, 0).call);
    expect(told).toHaveBeenCalledTimes(1);
    expect(serverClockSettled()).toBe(true);
  });

  // Value: protects=a later measurement within its error of the time shown keeps that time and tells no one, so an ordinary visit's clock doesn't jitter under the beacon strip; fails_when=every measurement is taken, or small differences re-plan the question; why_new=scheduled clock (owner); seam=fake timers; no_claim=none beyond protects
  it("keeps the time when a later measurement agrees within its error", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    const told = vi.fn();
    onServerOffset(told);
    vi.advanceTimersByTime(30_000);
    reply(TRUE_MS + 30_000 + MIN_CORRECTION_MS - 100, 100);
    expect(serverNow()).toBe(TRUE_MS + 30_000);
    expect(told).not.toHaveBeenCalled();
    expect(serverClockCorrections()).toBe(0);
  });

  // Value: protects=on an ordinary visit a quick measurement corrects the clock only when it's off by ORDINARY_CORRECTION_MS or more (an error that can name the wrong beacon), counting a correction and telling listeners; a smaller error stays, and a slow reply can't correct; fails_when=every error over the measurement's own is corrected mid-visit, re-planning questions (owner: correct only when it matters), or real errors are never corrected; why_new=scheduled clock (owner); seam=fake timers; no_claim=none beyond protects
  it("corrects an ordinary visit's clock only when it's off enough to matter", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    const told = vi.fn();
    onServerOffset(told);
    vi.advanceTimersByTime(30_000);
    reply(TRUE_MS + 30_000 + 5_000, 1_500);
    expect(serverNow()).toBe(TRUE_MS + 30_000);
    reply(TRUE_MS + 30_000 + ORDINARY_CORRECTION_MS - 100, 100);
    expect(serverNow()).toBe(TRUE_MS + 30_000);
    expect(told).not.toHaveBeenCalled();
    reply(TRUE_MS + 30_000 + ORDINARY_CORRECTION_MS + 100, 100);
    expect(serverNow()).toBe(TRUE_MS + 30_000 + ORDINARY_CORRECTION_MS + 100);
    expect(told).toHaveBeenCalledTimes(1);
    expect(serverClockCorrections()).toBe(1);
  });

  // Value: protects=a slow first measurement (a cold server's 4 s reply, up to 2 s off) is bettered: the page asks again soon and a quick reply corrects it; fails_when=the slow first offset is kept for the visit, or no ask is scheduled; why_new=round 3 final review (owner: scheduled re-measure); seam=fake timers, stubbed fetch; no_claim=network asymmetry
  it("betters a slow first measurement soon", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    const start = performance.now();
    const fetch = answering(() => TRUE_MS + performance.now() - start);
    vi.stubGlobal("fetch", fetch);
    // Took 4 s, and the server stamped it 1.5 s off the middle.
    noteResponse(precise(TRUE_MS - 2_000 + 1_500), Date.now() - 4_000, Date.now());
    expect(serverNow()).toBe(TRUE_MS + 1_500);
    // Value (extension): protects=a clock measured only roughly (a 4 s first reply, good to 2 s) reads as unsure until bettered, so beacon Listen waits for the quick re-ask rather than picking off it; fails_when=settled ignores how well the clock was measured; why_new=round 4 specialist review; seam=fake timers, stubbed fetch; no_claim=none beyond protects
    expect(serverClockSettled()).toBe(false);
    await vi.advanceTimersByTimeAsync(REMEASURE_RETRY_MS);
    expect(fetch).toHaveBeenCalledWith(REMEASURE_PATH, expect.objectContaining({ method: "HEAD" }));
    expect(Math.abs(serverNow() - (TRUE_MS + REMEASURE_RETRY_MS))).toBeLessThanOrEqual(1);
    expect(serverClockCorrections()).toBe(1);
    expect(serverClockSettled()).toBe(true);
  });

  // Value: protects=setting the computer's clock back doesn't move the server time the page works from, and a later measurement agrees, so nothing is corrected; fails_when=serverNow is tied to Date.now, or a backward drift is taken as a correction; why_new=clock TODO (owner: monotonic clock); seam=fake timers (setSystemTime moves only Date); no_claim=none
  it("ignores the computer's clock being set back", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    const told = vi.fn();
    onServerOffset(told);
    vi.setSystemTime(Date.now() - 3_600_000);
    expect(serverNow()).toBe(TRUE_MS);
    expect(serverClockSettled()).toBe(true);
    vi.advanceTimersByTime(1_000);
    reply(TRUE_MS + 1_000, 100);
    expect(serverNow()).toBe(TRUE_MS + 1_000);
    expect(told).not.toHaveBeenCalled();
    expect(serverClockCorrections()).toBe(0);
  });

  // Value: protects=after a sleep the monotonic clock lagged through, the time is right at once, listeners hear of the switch, the clock is unsettled, the page asks the server at once, and the reply keeps the time without a correction or another notice; fails_when=the time lags by the sleep, the switch is silent, nothing asks, or the reply counts as a correction (dropping a wake pick); why_new=clock TODO and its rounds; seam=fake timers (setSystemTime models the wall clock moving on while performance.now paused), stubbed fetch; no_claim=how a real browser pauses performance.now in sleep
  it("stays right through a sleep and confirms it with one ask", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    const fetch = answering(() => Date.now());
    vi.stubGlobal("fetch", fetch);
    const told = vi.fn();
    onServerOffset(told);
    const woke = TRUE_MS + 600_000;
    vi.setSystemTime(woke);
    expect(serverNow()).toBe(woke);
    expect(serverClockSettled()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(serverClockSettled()).toBe(true));
    // waitFor's own ticks moved both clocks on; the time is still the computer's, which kept time.
    expect(serverNow()).toBe(Date.now());
    expect(told).toHaveBeenCalledTimes(1);
    expect(serverClockCorrections()).toBe(0);
  });

  // Value: protects=a forward change by hand (even 2.2 s, just past JUMP_MS) is asked about at once and corrected, counted as a correction, and listeners hear both the switch and the correction; fails_when=the time shown is kept whenever near the measurement, or the correction isn't counted (a pick on the wrong time keeps context); why_new=round 3 adversarial review; seam=fake timers (setSystemTime moves only Date), stubbed fetch; no_claim=network asymmetry
  it("corrects a forward change by hand", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    const start = performance.now();
    vi.stubGlobal("fetch", answering(() => TRUE_MS + performance.now() - start));
    const told = vi.fn();
    onServerOffset(told);
    vi.setSystemTime(Date.now() + JUMP_MS + 200);
    expect(serverNow() - TRUE_MS).toBe(JUMP_MS + 200);
    await vi.waitFor(() => expect(serverClockSettled()).toBe(true));
    // Good to half the round trip, which waitFor's ticks stretched.
    expect(Math.abs(serverNow() - (TRUE_MS + performance.now() - start))).toBeLessThanOrEqual(50);
    expect(serverClockCorrections()).toBe(1);
    expect(told).toHaveBeenCalledTimes(2);
  });

  // Value: protects=a further jump while already on the computer's clock (a second sleep before any reply) tells listeners and asks again, so a planned question re-plans and a stale prompt can close; fails_when=only a switch between clocks notifies; why_new=round 3 final review (moves while on the computer's clock); seam=fake timers, a fetch that never answers; no_claim=none beyond protects
  it("tells listeners of a further jump while on the computer's clock", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    const told = vi.fn();
    onServerOffset(told);
    vi.setSystemTime(Date.now() + 60_000);
    serverNow();
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1_000);
    serverNow();
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 600_000);
    expect(serverNow()).toBe(Date.now());
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(2);
  });

  // Value: protects=a forward jump undone before any measurement counts as a correction (the time shown meanwhile was wrong) and tells listeners; fails_when=leaving the computer's clock is silent or uncounted; why_new=round 3 review; seam=fake timers, a fetch that never answers; no_claim=none beyond protects
  it("counts a jump undone before any measurement as a correction", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const told = vi.fn();
    onServerOffset(told);
    vi.setSystemTime(Date.now() + 60_000);
    serverNow();
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() - 60_000);
    expect(serverNow()).toBe(TRUE_MS);
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(2);
    expect(serverClockCorrections()).toBe(1);
  });

  // Value: protects=once on the computer's clock the page stays there until the drift is under LEAVE_WALL_CLOCK_MS, so jitter at JUMP_MS can't flap, and a reply inside that band still settles it; fails_when=one threshold both ways, or replies are refused inside the band; why_new=round 3 adversarial review; seam=fake timers, a fetch that never answers; no_claim=real clock jitter
  it("doesn't flap between clocks at the edge", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const told = vi.fn();
    onServerOffset(told);
    vi.setSystemTime(Date.now() + JUMP_MS + 100);
    serverNow();
    await Promise.resolve();
    vi.setSystemTime(Date.now() - 300);
    serverNow();
    await Promise.resolve();
    expect(told).toHaveBeenCalledTimes(1);
    expect(serverClockSettled()).toBe(false);
    reply(TRUE_MS, 100);
    expect(serverClockSettled()).toBe(true);
    expect(serverNow()).toBe(TRUE_MS);
  });

  // Value: protects=while on the computer's clock the page asks again every REMEASURE_RETRY_MS until a reply lands, never two asks at once, and stops once measured; fails_when=the ask is one-shot, overlaps, or keeps going after the clock settles; why_new=round 3 Codex review; seam=fake timers, stubbed fetch; no_claim=the deployed route's latency
  it("asks again every REMEASURE_RETRY_MS until the clock is measured", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    let answer = false;
    const fetch = vi.fn(async () => {
      if (!answer) throw new TypeError("offline");
      return new Response(null, { status: 204, headers: { [SERVER_MS_HEADER]: String(Date.now()) } });
    });
    vi.stubGlobal("fetch", fetch);
    vi.setSystemTime(Date.now() + 3_600_000);
    serverNow();
    serverNow();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REMEASURE_RETRY_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    answer = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(serverClockSettled()).toBe(true);
    await vi.advanceTimersByTimeAsync(REMEASURE_EVERY_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // Value: protects=the page measures every REMEASURE_EVERY_MS while visible (not while hidden), so slow drift between the two clocks is corrected on schedule rather than growing until a jump; fails_when=there is no schedule, it runs while hidden, or slow drift is never corrected; why_new=P3 TODO (owner: every 5 min + on wake); seam=fake timers (setSystemTime models the monotonic clock running slow), stubbed fetch; no_claim=real drift rates
  it("measures on a schedule while visible and corrects slow drift", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    // The true time is the computer's clock; the monotonic clock falls 1.6 s behind, under JUMP_MS.
    const fetch = answering(() => Date.now());
    vi.stubGlobal("fetch", fetch);
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(REMEASURE_EVERY_MS);
    expect(fetch).not.toHaveBeenCalled();
    visibility = "visible";
    vi.setSystemTime(Date.now() + ORDINARY_CORRECTION_MS + 100);
    await vi.advanceTimersByTimeAsync(REMEASURE_EVERY_MS - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(serverNow()).toBe(Date.now());
    expect(serverClockCorrections()).toBe(1);
  });

  // Value: protects=a tab that comes back into view after VISIBLE_REMEASURE_MS asks the server at once (a sleep the page didn't see as a jump, a long background stint), and not sooner; fails_when=becoming visible measures nothing, or every flip asks; why_new=P3 TODO (owner: on wake); seam=fake timers, stubbed fetch, visibility stubbed; no_claim=browser event order on wake
  it("asks when the tab comes back into view after a while", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    const fetch = answering(() => Date.now());
    vi.stubGlobal("fetch", fetch);
    const show = () => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    };
    visibility = "hidden";
    vi.advanceTimersByTime(VISIBLE_REMEASURE_MS - 1);
    show();
    expect(fetch).not.toHaveBeenCalled();
    visibility = "hidden";
    vi.advanceTimersByTime(1);
    show();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // Value: protects=an ordinary ask that fails tries again after REMEASURE_BACKOFF_MS, and a hung one is given up after REMEASURE_TIMEOUT_MS so the next can go; fails_when=failures retry at once or never, or a hung request blocks every later ask; why_new=round 3 final review (slow links); seam=fake timers, stubbed fetch that honors abort; no_claim=browser connection limits
  it("backs off after a failed ask and gives up a hung one", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    const signals: AbortSignal[] = [];
    const fetch = vi.fn(
      (_: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          signals.push(init!.signal!);
          init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await vi.advanceTimersByTimeAsync(REMEASURE_EVERY_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REMEASURE_TIMEOUT_MS);
    expect(signals[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(REMEASURE_BACKOFF_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // Value: protects=settleServerClock resolves once a measurement settles an unsure clock, or after its timeout when none comes, so beacon Listen never waits long; fails_when=it waits forever, or resolves before the measurement lands; why_new=P4 TODO (owner: beacon Listen waits for a measurement); seam=fake timers, stubbed fetch; no_claim=none beyond protects
  it("settles the clock on request, or gives up after a moment", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.setSystemTime(Date.now() + 60_000);
    const late = settleServerClock(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await late;
    expect(serverClockSettled()).toBe(false);
    const soon = settleServerClock(1_000);
    reply(TRUE_MS + 1_000, 100);
    await soon;
    expect(serverClockSettled()).toBe(true);
  });

  // Value: protects=a settleServerClock wait ends as soon as the jump is undone (the clock is settled again without a reply), so beacon Listen doesn't sit out its full timeout; fails_when=leaving the computer's clock doesn't release the waiters; why_new=the settle test only settles by a reply or the timeout; seam=fake timers, a fetch that never answers; no_claim=none beyond protects
  it("ends a settle wait when the jump is undone", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.setSystemTime(Date.now() + 60_000);
    let done = false;
    void settleServerClock(10_000).then(() => (done = true));
    vi.setSystemTime(Date.now() - 60_000);
    serverNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(serverClockSettled()).toBe(true);
  });

  // Value: protects=a quick reply that agrees with a poorly measured clock (a Date-header first reading) tightens what the clock is known to, so the visit then gets the ordinary ORDINARY_CORRECTION_MS band instead of re-planning on every sub-1.5 s difference; fails_when=a kept measurement leaves offsetError as it was; why_new=no test reads the band after a kept measurement; seam=fake timers; no_claim=none beyond protects
  it("tightens a poorly measured clock when a reply agrees", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    // Date header after a 400 ms round trip: good only to 700 ms.
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now() - 400, Date.now());
    const shown = serverNow();
    reply(shown, 100);
    expect(serverNow()).toBe(shown);
    reply(shown + 1_000, 100);
    expect(serverNow()).toBe(shown);
    expect(serverClockCorrections()).toBe(0);
  });

  // Value: protects=a reply that is the first to see a sleep (nothing called serverNow since) still tells listeners the time shown moved, while counting no correction; fails_when=noteResponse notifies only on the first offset or a correction, so a planned beacon question stays on the old clock; why_new=the sleep tests call serverNow before the reply; seam=fake timers (setSystemTime models the wall clock moving on while performance.now paused); no_claim=none beyond protects
  it("tells listeners of a sleep first seen by a reply", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    const told = vi.fn();
    onServerOffset(told);
    vi.setSystemTime(Date.now() + 600_000);
    reply(Date.now(), 100);
    expect(serverNow()).toBe(Date.now());
    expect(told).toHaveBeenCalledTimes(1);
    expect(serverClockCorrections()).toBe(0);
  });

  // Value: protects=a tab shown after a sleep the monotonic clock paused through (so it looks recently measured) still switches to the computer's clock and asks the server at once; fails_when=the visibility handler skips serverNow and judges only by performance.now since the last measurement; why_new=the visibility test advances both clocks, never a paused monotonic one; seam=fake timers (setSystemTime models a sleep), stubbed fetch, visibility stubbed; no_claim=browser event order on wake
  it("asks when the tab is shown after a sleep the monotonic clock missed", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    visibility = "hidden";
    vi.setSystemTime(Date.now() + 600_000);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(serverClockSettled()).toBe(false);
  });

  // Value: protects=on a link slower than QUICK_ROUND_TRIP_MS every time, a later reply that measures better than the clock is known to is still taken, and the clock counts as settled once it's been asked again, so beacon Listen doesn't wait 2 s on every click for good; fails_when=every slow later reply is dropped, or settled requires a quick measurement; why_new=round 4 adversarial review (owner: fix slow links); seam=fake timers; no_claim=what counts as slow on a real network
  it("takes a better slow reply, and settles a slow link once asked again", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS + 1_900, 4_000);
    expect(serverNow()).toBe(TRUE_MS + 1_900);
    expect(serverClockSettled()).toBe(false);
    // 1.2 s: still slow, but good to 0.6 s against the first's 2 s.
    reply(TRUE_MS, 1_200);
    expect(serverNow()).toBe(TRUE_MS);
    expect(serverClockCorrections()).toBe(1);
    resetServerClock();
    reply(TRUE_MS, 3_000);
    expect(serverClockSettled()).toBe(false);
    // Another reply to a request sent alongside the first isn't an ask again.
    noteResponse(precise(TRUE_MS + 1_000), Date.now() - 3_000, Date.now());
    expect(serverClockSettled()).toBe(false);
    vi.advanceTimersByTime(3_000);
    // As slow again, asked after the first landed: nothing better to be had on this link.
    reply(TRUE_MS + 4_000, 3_000);
    expect(serverNow()).toBe(TRUE_MS + 3_000);
    expect(serverClockSettled()).toBe(true);
  });

  // Value: protects=a beacon Listen waiting on a slow link's clock goes ahead as soon as a reply as slow as the first (a request sent after it landed) settles the link on its best, not after the full 2 s; fails_when=a dropped slow reply that settles the clock doesn't release the settle wait; why_new=round 4 fix-check of the slow-link fix; seam=fake timers, a fetch that never answers, the reply fed by hand; no_claim=none beyond protects
  it("ends a settle wait when a slow link settles", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    reply(TRUE_MS, 3_000);
    vi.advanceTimersByTime(3_000);
    let done = false;
    void settleServerClock().then(() => {
      done = true;
    });
    // A request sent as the first reply landed answers, as slowly.
    reply(TRUE_MS + 3_000, 3_000);
    await Promise.resolve();
    expect(serverClockSettled()).toBe(true);
    expect(done).toBe(true);
  });

  // Value: protects=after a sleep, a slow reply still corrects the time counted from the computer's clock (any measurement beats none); fails_when=slow later replies are dropped even on the computer's clock; why_new=round 4 adversarial review (owner: fix slow links); seam=fake timers, a fetch that never answers; no_claim=none beyond protects
  it("takes a slow reply after a sleep", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    reply(TRUE_MS);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const woke = TRUE_MS + 600_000;
    vi.setSystemTime(woke);
    expect(serverClockSettled()).toBe(false);
    reply(woke + 2_000, 3_000);
    expect(serverNow()).toBe(woke + 2_000);
  });

  // Value: protects=the round trip is timed on the monotonic clock, so the computer's clock stepped while a request is out doesn't skew the measurement; fails_when=clockedFetch times the round trip with Date.now(); why_new=round 4 adversarial review (owner: fix it); seam=fake timers (setSystemTime moves only Date), a stubbed fetch that steps the clock; no_claim=none beyond protects
  it("times the round trip on the monotonic clock", async () => {
    vi.useFakeTimers({ now: TRUE_MS });
    const stamp = TRUE_MS + 7_000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        vi.setSystemTime(Date.now() + 3_000);
        return new Response(null, { status: 204, headers: { [SERVER_MS_HEADER]: String(stamp) } });
      }),
    );
    await clockedFetch("/api/trpc/clock");
    expect(serverNow()).toBe(stamp);
  });

  // Value: protects=a listener that throws neither fails the response that measured the clock (a tRPC call) nor keeps the other listeners from hearing; fails_when=listeners run bare inside noteResponse; why_new=clock-edges TODO; seam=console.error spied; no_claim=none beyond protects
  it("keeps measuring when a listener throws", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onServerOffset(() => {
      throw new Error("boom");
    });
    const told = vi.fn();
    onServerOffset(told);
    expect(() => reply(TRUE_MS)).not.toThrow();
    expect(told).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });
});

function AQuery() {
  const trpc = useTRPC();
  useQuery(trpc.presets.list.queryOptions());
  return null;
}

// Value: protects=the re-measure path reaches the tRPC route handler (app/api/trpc/[trpc]), which answers every request fresh with the ms header, not a bare /api/trpc that matches no route and is served a cached not-found page; fails_when=REMEASURE_PATH points anywhere but under /api/trpc/ or the route moves; why_new=round 3 fix-check; seam=none (reads the route file); no_claim=what Vercel's edge does (checked with curl on production)
it("re-measures through the tRPC route handler", async () => {
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  expect(REMEASURE_PATH).toMatch(/^\/api\/trpc\/[a-z]+$/);
  expect(existsSync(resolve(__dirname, "../app/api/trpc/[trpc]/route.ts"))).toBe(true);
});

// Value: protects=the tRPC client really reads the server's time from responses (the wiring, not just the math); fails_when=Providers stops passing clockedFetch to its links; why_new=server clock; seam=stubbed fetch; no_claim=what the deployed route sends (route test)
it("takes the server's time from a tRPC response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { status: 500, headers: { [SERVER_MS_HEADER]: String(Date.now() + 5_000) } })),
  );
  render(
    <Providers>
      <AQuery />
    </Providers>,
  );
  await waitFor(() => expect(serverOffset()).not.toBeNull());
  expect(serverOffset()!).toBeGreaterThan(4_000);
  expect(serverOffset()!).toBeLessThan(6_000);
});
