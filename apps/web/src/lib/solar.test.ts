import { describe, expect, it } from "vitest";
import {
  MAX_MERCATOR_LAT,
  NIGHT_ELEVATION,
  TWILIGHT_ELEVATION,
  darkRegion,
  isNight,
  sunElevation,
  sunPosition,
} from "./solar";

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

/** Whether a point is inside GeoJSON MultiPolygon coordinates (even-odd rule). */
function inside(region: [number, number][][][], lon: number, lat: number): boolean {
  let hit = false;
  for (const [ring] of region) {
    for (let i = 0, j = ring!.length - 1; i < ring!.length; j = i++) {
      const [xi, yi] = ring![i]!;
      const [xj, yj] = ring![j]!;
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

describe("darkRegion", () => {
  const sunAt = (declination: number, subsolarLon: number) => ({ declination, subsolarLon });

  // Value: protects=the shading matches where the sun is actually down, at solstices, equinox and near-equinox; fails_when=the cap is centered wrongly, closed on the wrong pole, or not cut at the date line; why_new=receiver map greyline (R6); seam=none; no_claim=points within half a degree of the edge or past Mercator's limit
  it.each([
    ["June solstice", sunAt(23.44, 30), NIGHT_ELEVATION],
    ["December solstice", sunAt(-23.44, -150), NIGHT_ELEVATION],
    ["equinox", sunAt(0, 100), NIGHT_ELEVATION],
    ["+0.5° (no pole)", sunAt(0.5, 170), NIGHT_ELEVATION],
    ["-0.5° (no pole)", sunAt(-0.5, -175), NIGHT_ELEVATION],
    ["twilight at +6.5°", sunAt(6.5, 0), TWILIGHT_ELEVATION],
    ["twilight at -5.5°", sunAt(-5.5, 179), TWILIGHT_ELEVATION],
  ])("covers exactly where the sun is below the threshold: %s", (_case, sun, threshold) => {
    const region = darkRegion(sun, threshold);
    for (let lat = -84; lat <= 84; lat += 3) {
      for (let lon = -179; lon <= 179; lon += 4) {
        const e = sunElevation(lat, lon, sun);
        if (Math.abs(e - threshold) < 0.5) continue;
        expect(inside(region, lon, lat), `${lon},${lat} at elevation ${e.toFixed(2)}`).toBe(e < threshold);
      }
    }
  });

  // Value: protects=MapLibre gets valid Web Mercator rings; fails_when=a point escapes ±180°/±85.05° or a ring isn't closed; why_new=receiver map; seam=none; no_claim=none beyond protects
  it.each([sunAt(23.44, 179.5), sunAt(0, -180), sunAt(-10, 0)])("stays on the map: %o", (sun) => {
    for (const [ring] of darkRegion(sun, NIGHT_ELEVATION)) {
      expect(ring![0]).toEqual(ring![ring!.length - 1]);
      for (const [lon, lat] of ring!) {
        expect(Math.abs(lon)).toBeLessThanOrEqual(180);
        expect(Math.abs(lat)).toBeLessThanOrEqual(MAX_MERCATOR_LAT);
      }
    }
  });

  // Value: protects=the polar night is shaded all the way up; fails_when=the pole closure picks the wrong pole or is skipped; why_new=R6; seam=none; no_claim=none beyond protects
  it("closes along the pole the night contains, and only then", () => {
    // June: the south pole is in darkness, the north isn't.
    const june = darkRegion(sunAt(23.44, 0), NIGHT_ELEVATION);
    expect(inside(june, 0, -84.9)).toBe(true);
    expect(inside(june, 0, 84.9)).toBe(false);
    // Close to the equinox, neither pole: the cap is a loop. It still reaches
    // the map's top edge on the night side, but the day side there stays clear.
    const near = darkRegion(sunAt(0.5, 0), NIGHT_ELEVATION);
    expect(inside(near, 179, 84.9)).toBe(true);
    expect(inside(near, 0, 84.9)).toBe(false);
    expect(inside(near, 0, -84.9)).toBe(false);
  });
});
