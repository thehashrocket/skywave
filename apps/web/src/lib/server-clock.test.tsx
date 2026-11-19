// @vitest-environment jsdom
import { useQuery } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beaconOnBand } from "./ibp";
import {
  DATE_HEADER_ROUNDING_MS,
  MAX_ROUND_TRIP_MS,
  noteResponse,
  offsetFromResponse,
  onServerOffset,
  REMEASURE_MS,
  REMEASURE_ROUND_TRIP_MS,
  resetServerClock,
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
  // Value: protects=a browser clock 5 s off still names the beacon on the air (issue #59's gotcha), and a later response that agrees within REMEASURE_MS doesn't move it; fails_when=the IBP math uses the raw clock, or jitter shifts the offset; why_new=server clock; seam=fake system time; no_claim=sub-second accuracy
  it("corrects a 5-second skew so the right beacon is named", () => {
    vi.useFakeTimers({ now: TRUE_MS + SKEW_MS });
    // Uncorrected, the slow clock names the beacon from the slot before.
    expect(beaconOnBand(Date.now(), 0).call).not.toBe(beaconOnBand(TRUE_MS, 0).call);

    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    expect(Math.abs(serverNow() - TRUE_MS)).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS);
    expect(beaconOnBand(serverNow(), 0).call).toBe(beaconOnBand(TRUE_MS, 0).call);

    // A later response off by a second (header rounding, a slower trip) doesn't move it.
    const first = serverOffset();
    noteResponse(headers({ date: new Date(TRUE_MS + 1_000).toUTCString() }), Date.now(), Date.now());
    expect(serverOffset()).toBe(first);
  });

  // Value: protects=after the browser's clock jumps (sleep, a manual change, an NTP step) a quick response corrects the offset and tells the beacon strip, while a slow one can't; fails_when=the offset is measured once only, a slow round trip replaces it, or listeners aren't told; why_new=edge-case fixes (stale offset, owner: re-measure); seam=fake system time; no_claim=network asymmetry
  it("re-measures after the browser's clock jumps, from a quick response only", () => {
    vi.useFakeTimers({ now: TRUE_MS });
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now(), Date.now());
    expect(Math.abs(serverNow() - TRUE_MS)).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS);
    const told = vi.fn();
    const off = onServerOffset(told);

    // The browser's clock steps 60 s back while the server's keeps time.
    vi.setSystemTime(TRUE_MS - 60_000);
    expect(serverNow() - TRUE_MS).toBeLessThan(-REMEASURE_MS);
    // A slow response can't be trusted to that degree.
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now() - REMEASURE_ROUND_TRIP_MS - 1, Date.now());
    expect(told).not.toHaveBeenCalled();
    noteResponse(headers({ date: new Date(TRUE_MS).toUTCString() }), Date.now() - 100, Date.now());
    expect(told).toHaveBeenCalledTimes(1);
    expect(Math.abs(serverNow() - TRUE_MS)).toBeLessThanOrEqual(DATE_HEADER_ROUNDING_MS + 50);
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
