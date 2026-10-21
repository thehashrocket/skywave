/**
 * Where the sun is, to about 0.01°: enough to say which receivers are in the
 * dark. Low-precision formulas from the Astronomical Almanac (as used by
 * NOAA's solar calculator), good for 1950-2050.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J2000 = 2_451_545;
const UNIX_EPOCH_JD = 2_440_587.5;

/**
 * The sun counts as down below this elevation: sunset, with the solar radius
 * and atmospheric refraction (the -0.833° standard).
 */
export const NIGHT_ELEVATION = -0.833;

export type SunPosition = {
  /** Latitude where the sun is overhead, in degrees. */
  declination: number;
  /** Longitude where the sun is overhead, in degrees, -180..180. */
  subsolarLon: number;
};

export function sunPosition(time: Date | number): SunPosition {
  const n = +time / DAY_MS + UNIX_EPOCH_JD - J2000;
  const meanLon = 280.46 + 0.9856474 * n;
  const anomaly = (357.528 + 0.9856003 * n) * RAD;
  const eclipticLon = (meanLon + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * RAD;
  const obliquity = (23.439 - 0.0000004 * n) * RAD;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLon)) / RAD;
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLon), Math.cos(eclipticLon)) / RAD;
  // Greenwich mean sidereal time, in degrees.
  const gmst = 280.46061837 + 360.98564736629 * n;
  return { declination, subsolarLon: wrapLon(rightAscension - gmst) };
}

/** The sun's elevation above the horizon at a place, in degrees. */
export function sunElevation(lat: number, lon: number, sun: SunPosition): number {
  const hourAngle = (lon - sun.subsolarLon) * RAD;
  const phi = lat * RAD;
  const delta = sun.declination * RAD;
  const sin = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sin))) / RAD;
}

/** End of civil twilight: the sun 6° below the horizon. */
export const TWILIGHT_ELEVATION = -6;

/** Web Mercator's latitude limit; regions are clamped to it. */
export const MAX_MERCATOR_LAT = 85.05;

/** A ring of [lon, lat] points; the first point isn't repeated at the end. */
type Ring = [number, number][];

/**
 * Where the sun is below `elevation` (negative, in degrees), as GeoJSON
 * MultiPolygon coordinates. It's a spherical cap around the point opposite
 * the sun: closed along a pole when it contains one, a loop otherwise, cut
 * at ±180° and clamped to Web Mercator's latitudes.
 */
export function darkRegion(sun: SunPosition, elevation: number): [number, number][][][] {
  const centerLat = -sun.declination;
  const centerLon = wrapLon(sun.subsolarLon + 180);
  const radius = 90 + elevation;
  const phi1 = centerLat * RAD;
  const delta = radius * RAD;

  // The cap's edge, one point per degree of azimuth, with longitudes unwrapped
  // so the ring never jumps by 360°.
  const ring: Ring = [];
  for (let az = 0; az < 360; az++) {
    const theta = az * RAD;
    const sinLat = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
    const lat = Math.asin(Math.max(-1, Math.min(1, sinLat)));
    const dLon = Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(lat),
    );
    let lon = centerLon + dLon / RAD;
    const prev = ring[ring.length - 1];
    if (prev) lon += 360 * Math.round((prev[0] - lon) / 360);
    ring.push([lon, clampLat(lat / RAD)]);
  }

  // The cap holds a pole when it reaches past it: the pole on the center's side.
  if (90 - Math.abs(centerLat) < radius) {
    const pole = Math.sign(centerLat || 1) * MAX_MERCATOR_LAT;
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    // Around a pole the edge winds once round the globe: finish the lap back
    // to the first point's longitude, then close along the pole.
    const end = first[0] + 360 * Math.sign(last[0] - first[0]);
    ring.push([end, first[1]], [end, pole], [first[0], pole]);
  }

  // Draw the ring and its copies one world either side, each cut to -180..180.
  const pieces: [number, number][][][] = [];
  for (const shift of [-360, 0, 360]) {
    const shifted: Ring = ring.map(([lon, lat]) => [lon + shift, lat]);
    const clipped = clipLon(clipLon(shifted, -180, 1), 180, -1);
    if (clipped.length >= 3) pieces.push([[...clipped, clipped[0]!]]);
  }
  return pieces;
}

function clampLat(lat: number): number {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

/** Keeps the part of a ring on one side of a meridian: lon >= edge (side 1) or lon <= edge (side -1). */
function clipLon(ring: Ring, edge: number, side: 1 | -1): Ring {
  const inside = (p: [number, number]) => (p[0] - edge) * side >= 0;
  const out: Ring = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) {
      const t = (edge - a[0]) / (b[0] - a[0]);
      out.push([edge, a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

/** Whether the sun has set at a place. */
export function isNight(lat: number, lon: number, sun: SunPosition): boolean {
  return sunElevation(lat, lon, sun) < NIGHT_ELEVATION;
}

function wrapLon(deg: number): number {
  const d = (((deg + 180) % 360) + 360) % 360;
  return d - 180;
}
