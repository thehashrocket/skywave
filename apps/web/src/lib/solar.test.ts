import { describe, expect, it } from "vitest";
import { NIGHT_ELEVATION, isNight, sunElevation, sunPosition } from "./solar";

describe("sunPosition", () => {
  // Value: protects=the Night column and greyline put the dark side in the right place; fails_when=the declination formula or epoch is wrong; why_new=receiver map needs the sun; seam=none; no_claim=precision better than ~0.1°
  it.each([
    ["2024-06-20T20:51:00Z", 23.44], // June solstice
    ["2024-12-21T09:20:00Z", -23.44], // December solstice
    ["2024-03-20T03:06:00Z", 0], // March equinox
  ])("puts the sun at the right latitude on %s", (time, declination) => {
    expect(sunPosition(new Date(time)).declination).toBeCloseTo(declination, 1);
  });

  // Value: protects=the dark side sits at the right longitude; fails_when=sidereal time or the sign of the subsolar longitude is wrong; why_new=receiver map needs the sun; seam=none; no_claim=better than ~0.5°
  it("puts the sun over Greenwich around noon UTC", () => {
    // The equation of time is about -7.5 min on March 20: solar noon at 12:07.
    expect(sunPosition(Date.parse("2024-03-20T12:07:30Z")).subsolarLon).toBeCloseTo(0, 0);
    // An hour later the sun is 15° further west.
    expect(sunPosition(Date.parse("2024-03-20T13:07:30Z")).subsolarLon).toBeCloseTo(-15, 0);
  });

  // Value: protects=the greyline and night caps can build rings from the longitude; fails_when=wrapLon misses a range; why_new=receiver map; seam=none; no_claim=none beyond protects
  it("keeps the longitude in -180..180", () => {
    for (let h = 0; h < 48; h++) {
      const { subsolarLon } = sunPosition(Date.parse("2026-10-20T00:00:00Z") + h * 3_600_000);
      expect(subsolarLon).toBeGreaterThanOrEqual(-180);
      expect(subsolarLon).toBeLessThan(180);
    }
  });
});

describe("sunElevation", () => {
  // Value: protects=Night flips at real sunset in both hemispheres; fails_when=the hour angle, latitude sign or threshold is wrong; why_new=Night column; seam=none; no_claim=local terrain or weather
  it.each([
    ["Boulder, CO", "2024-06-22T02:32:00Z", 40.015, -105.27], // 20:32 MDT, NOAA
    ["Sydney", "2024-12-21T09:05:00Z", -33.87, 151.21], // 20:05 AEDT
  ])("is at the sunset angle at a published %s sunset", (_place, time, lat, lon) => {
    const sun = sunPosition(Date.parse(time));
    expect(Math.abs(sunElevation(lat, lon, sun) - NIGHT_ELEVATION)).toBeLessThan(0.3);
  });

  it("agrees on both sides of the date line", () => {
    // The sun is near the antimeridian around 00:07 UTC on March 20.
    const sun = sunPosition(Date.parse("2024-03-20T00:07:30Z"));
    expect(sunElevation(0, 179.9, sun)).toBeGreaterThan(85);
    expect(sunElevation(0, -179.9, sun)).toBeGreaterThan(85);
  });

  // Value: protects=isNight uses the sunset threshold, not the horizon; fails_when=isNight compares with 0; why_new=Night column; seam=none; no_claim=twilight (PR 2)
  it("calls it night opposite the sun and day under it", () => {
    const sun = sunPosition(Date.parse("2026-10-20T12:00:00Z"));
    expect(isNight(sun.declination, sun.subsolarLon, sun)).toBe(false);
    expect(isNight(-sun.declination, sun.subsolarLon + 180, sun)).toBe(true);
    // Just past the horizon is still day: the sun's disc and refraction.
    expect(isNight(sun.declination, sun.subsolarLon + 90.5, sun)).toBe(false);
  });
});
