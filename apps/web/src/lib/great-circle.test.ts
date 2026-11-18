import { describe, expect, it } from "vitest";
import { distanceKm, greatCirclePath, midpoint } from "./great-circle";

const NEW_YORK = { lat: 40.771, lon: -73.958 };
const LONDON = { lat: 51.5, lon: -0.12 };
const MAUI = { lat: 20.771, lon: -156.375 };
const MASTERTON = { lat: -41.063, lon: 175.625 };

describe("great-circle", () => {
  // Value: protects=distances are real short-path km (New York–London is ~5,570 km), symmetric, zero to itself; fails_when=degrees and radians are mixed, or the formula is wrong; why_new=beacon ranking; seam=none; no_claim=ellipsoid accuracy
  it("measures short-path distance", () => {
    expect(distanceKm(NEW_YORK, LONDON)).toBeGreaterThan(5_540);
    expect(distanceKm(NEW_YORK, LONDON)).toBeLessThan(5_600);
    expect(distanceKm(LONDON, NEW_YORK)).toBeCloseTo(distanceKm(NEW_YORK, LONDON), 6);
    expect(distanceKm(LONDON, LONDON)).toBe(0);
  });

  // Value: protects=the midpoint lies on the path, equally far from both ends (and north of both for a transatlantic path, as great circles bow poleward); fails_when=it averages lat/lon; why_new=beacon ranking (daylight at the midpoint); seam=none; no_claim=none
  it("finds the path's midpoint", () => {
    const m = midpoint(NEW_YORK, LONDON);
    expect(distanceKm(NEW_YORK, m)).toBeCloseTo(distanceKm(m, LONDON), 3);
    expect(m.lat).toBeGreaterThan(51.5);
  });

  // Value: protects=a path across the antimeridian is cut into two lines meeting at ±180°, so the map doesn't draw a line across the world; fails_when=longitudes jump by ~360° inside one line; why_new=beacon path on the map; seam=none; no_claim=none
  it("cuts a path where it crosses ±180°", () => {
    const lines = greatCirclePath(MAUI, MASTERTON, 32);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.at(-1)![0]).toBe(-180);
    expect(lines[1]![0]![0]).toBe(180);
    expect(lines[0]!.at(-1)![1]).toBeCloseTo(lines[1]![0]![1], 6);
    for (const line of lines)
      for (let i = 1; i < line.length; i++) expect(Math.abs(line[i]![0] - line[i - 1]![0])).toBeLessThan(180);
    // One that doesn't cross stays one line, end to end.
    const one = greatCirclePath(NEW_YORK, LONDON, 16);
    expect(one).toHaveLength(1);
    expect(one[0]).toHaveLength(17);
    expect(one[0]![0]).toEqual([NEW_YORK.lon, NEW_YORK.lat].map((v) => expect.closeTo(v, 6)));
  });
});
