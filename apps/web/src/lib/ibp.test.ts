import { describe, expect, it } from "vitest";
import {
  BEACONS,
  beaconOnBand,
  CYCLE_MS,
  findBeacon,
  IBP_BANDS_KHZ,
  IBP_TOLERANCE_KHZ,
  ibpBandIndex,
  msLeftInSlot,
  SLOT_MS,
  slotAt,
} from "./ibp";

const utc = (h: number, m: number, s: number, ms = 0) => Date.UTC(2026, 10, 18, h, m, s, ms);
const calls = (ms: number) => IBP_BANDS_KHZ.map((_, b) => beaconOnBand(ms, b).call);

/** Centre of a 6-character Maidenhead locator, as [lat, lon]. */
function gridCentre(grid: string): [number, number] {
  const g = grid.toUpperCase();
  const at = (i: number) => g.charCodeAt(i) - 65;
  const lon = -180 + at(0) * 20 + Number(g[2]) * 2 + at(4) * (5 / 60) + 2.5 / 60;
  const lat = -90 + at(1) * 10 + Number(g[3]) + at(5) * (2.5 / 60) + 1.25 / 60;
  return [lat, lon];
}

describe("IBP beacon table", () => {
  // Value: protects=each beacon's map position matches the NCDXF grid square it's listed with; fails_when=a coordinate is mistyped or swapped (lat/lon, sign); why_new=beacon table; seam=none; no_claim=that NCDXF's grid squares are right
  it("puts every beacon at the centre of its NCDXF grid square", () => {
    expect(BEACONS).toHaveLength(18);
    for (const b of BEACONS) {
      const [lat, lon] = gridCentre(b.grid);
      expect(b.lat, b.call).toBeCloseTo(lat, 2);
      expect(b.lon, b.call).toBeCloseTo(lon, 2);
    }
  });

  // Value: protects=the transmission order NCDXF publishes (and the issue's VE8AT move); fails_when=a beacon is dropped, duplicated or reordered; why_new=beacon table; seam=none; no_claim=live beacon status
  it("lists the beacons in NCDXF's slot order", () => {
    expect(BEACONS.map((b) => b.call)).toEqual([
      "4U1UN",
      "VE8AT",
      "W6WX",
      "KH6RS",
      "ZL6B",
      "VK6RBP",
      "JA2IGY",
      "RR9O",
      "VR2B",
      "4S7B",
      "ZS6DN",
      "5Z4B",
      "4X6TU",
      "OH2B",
      "CS3B",
      "LU4AA",
      "OA4B",
      "YV5B",
    ]);
    expect(findBeacon("VE8AT")?.location).toBe("Inuvik, NT");
  });
});

describe("IBP schedule", () => {
  // Value: protects=the published 00:00:00 UTC line-up (4U1UN opens 14.100 while YV5B, OA4B, LU4AA and CS3B hold the bands above); fails_when=the band offset runs the wrong way or the cycle isn't anchored at midnight; why_new=beacon schedule; seam=none; no_claim=propagation
  it("matches the schedule at the top of the cycle", () => {
    expect(calls(utc(0, 0, 0))).toEqual(["4U1UN", "YV5B", "OA4B", "LU4AA", "CS3B"]);
    // Every 3 minutes, all day, the same line-up.
    expect(calls(utc(13, 57, 0))).toEqual(["4U1UN", "YV5B", "OA4B", "LU4AA", "CS3B"]);
  });

  // Value: protects=a beacon steps up one band each slot while the next in the list takes its old one; fails_when=the step direction or size is wrong; why_new=beacon schedule; seam=none; no_claim=none
  it("moves each beacon up a band every 10 seconds", () => {
    expect(calls(utc(0, 0, 10))).toEqual(["VE8AT", "4U1UN", "YV5B", "OA4B", "LU4AA"]);
    expect(calls(utc(0, 0, 20))).toEqual(["W6WX", "VE8AT", "4U1UN", "YV5B", "OA4B"]);
    // 2 minutes 50 seconds in: the last slot of the cycle.
    expect(calls(utc(12, 2, 50))).toEqual(["YV5B", "OA4B", "LU4AA", "CS3B", "OH2B"]);
    // 12:01:30 is slot 9 of its cycle (12:00:00 starts one).
    expect(calls(utc(12, 1, 30))).toEqual(["4S7B", "VR2B", "RR9O", "JA2IGY", "VK6RBP"]);
  });

  // Value: protects=slot edges: the last millisecond of a slot belongs to it, the next to the next slot; fails_when=rounding moves the edge; why_new=beacon schedule; seam=none; no_claim=audio latency
  it("changes slot exactly on the 10-second boundary", () => {
    expect(slotAt(utc(0, 0, 9, 999))).toBe(0);
    expect(slotAt(utc(0, 0, 10))).toBe(1);
    expect(slotAt(utc(0, 2, 59, 999))).toBe(17);
    expect(slotAt(utc(0, 3, 0))).toBe(0);
    expect(msLeftInSlot(utc(0, 0, 10))).toBe(SLOT_MS);
    expect(msLeftInSlot(utc(0, 0, 19, 999))).toBe(1);
    expect(msLeftInSlot(utc(0, 0, 13))).toBe(7_000);
  });

  // Value: protects=the cycle runs straight through midnight UTC, with no jump or repeated slot; fails_when=the slot is computed from local time or a day that isn't a whole number of cycles; why_new=beacon schedule; seam=none; no_claim=leap seconds
  it("rolls over midnight UTC without a break", () => {
    const midnight = Date.UTC(2026, 10, 19);
    expect(slotAt(midnight - 1)).toBe(17);
    expect(slotAt(midnight)).toBe(0);
    expect(calls(midnight - SLOT_MS)).toEqual(["YV5B", "OA4B", "LU4AA", "CS3B", "OH2B"]);
    expect(calls(midnight)).toEqual(["4U1UN", "YV5B", "OA4B", "LU4AA", "CS3B"]);
    expect((24 * 3600_000) % CYCLE_MS).toBe(0);
  });

  // Value: protects=every band carries a different beacon at once (NCDXF: "no two beacons on the same frequency"); fails_when=two bands share a beacon; why_new=beacon schedule; seam=none; no_claim=none
  it("never puts one beacon on two bands at once", () => {
    for (let t = 0; t < CYCLE_MS; t += SLOT_MS) expect(new Set(calls(utc(5, 0, 0) + t)).size).toBe(5);
  });

  // Value: protects=times before the Unix epoch don't index outside the table; fails_when=% goes negative; why_new=beacon schedule; seam=none; no_claim=none
  it("handles times before 1970", () => {
    expect(slotAt(-1)).toBe(17);
    expect(beaconOnBand(-1, 4)).toBeDefined();
  });
});

describe("ibpBandIndex", () => {
  // Value: protects=only a dial on (or within half the CW passband of) a beacon frequency counts; fails_when=the tolerance is too wide or ignored; why_new=beacon prompt; seam=none; no_claim=what the receiver hears
  it("finds the band within the CW passband, and nothing off it", () => {
    expect(ibpBandIndex(14_100)).toBe(0);
    expect(ibpBandIndex(28_200 + IBP_TOLERANCE_KHZ)).toBe(4);
    expect(ibpBandIndex(21_150 - IBP_TOLERANCE_KHZ - 0.01)).toBe(-1);
    expect(ibpBandIndex(14_000)).toBe(-1);
  });
});
