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

/** Whether the sun has set at a place. */
export function isNight(lat: number, lon: number, sun: SunPosition): boolean {
  return sunElevation(lat, lon, sun) < NIGHT_ELEVATION;
}

function wrapLon(deg: number): number {
  const d = (((deg + 180) % 360) + 360) % 360;
  return d - 180;
}
