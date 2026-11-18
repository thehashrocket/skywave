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
