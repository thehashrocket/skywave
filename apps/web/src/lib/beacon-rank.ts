/**
 * Which receivers to try for an IBP beacon (issue #59): by where they sit
 * relative to the beacon, not by the list's whole-HF SNR alone. Pure; the
 * page passes the result to Pick best, which works down it.
 */

import { distanceKm, kmOutsideRange, midpoint } from "./great-circle";
import type { Beacon } from "./ibp";
import { byRank, covers, isFull, type Receiver } from "./kiwi-list";
import { NIGHT_ELEVATION, sunElevation, type SunPosition } from "./solar";

/**
 * Nearer than this, a receiver is usually inside the beacon's skip zone on
 * 14–28 MHz: the sky wave lands beyond it and the ground wave dies out within
 * a few tens of km.
 */
export const MIN_BEACON_KM = 1_000;

/**
 * Farther than this takes three or more hops off the ionosphere, and the
 * 100 mW dash rarely makes it; one or two hops is where the power steps say
 * something about the path.
 */
export const MAX_BEACON_KM = 8_000;

/**
 * At and above this frequency the F2 layer needs sunlight to bend the signal
 * back: a path whose midpoint is dark is usually closed. Every IBP band is at
 * or above it; 14 MHz itself often stays open into the evening, so this is a
 * preference, not a filter.
 */
export const DAYLIGHT_KHZ = 14_000;

/** How one receiver sits for a beacon. Distance and daylight are null without a position. */
export type BeaconFit = {
  distanceKm: number | null;
  /** In MIN_BEACON_KM..MAX_BEACON_KM. */
  inRange: boolean;
  /** How far outside that range, in km; 0 inside it, Infinity without a position. */
  kmOutside: number;
  /** The path's midpoint is in daylight (true below DAYLIGHT_KHZ, where it doesn't matter). */
  sunlit: boolean;
};

export function beaconFit(r: Receiver, beacon: Beacon, bandKhz: number, sun: SunPosition): BeaconFit {
  if (r.lat === undefined || r.lon === undefined)
    return { distanceKm: null, inRange: false, kmOutside: Infinity, sunlit: false };
  const at = { lat: r.lat, lon: r.lon };
  const km = distanceKm(beacon, at);
  const kmOutside = kmOutsideRange(km, MIN_BEACON_KM, MAX_BEACON_KM);
  const mid = midpoint(beacon, at);
  const sunlit = bandKhz < DAYLIGHT_KHZ || sunElevation(mid.lat, mid.lon, sun) >= NIGHT_ELEVATION;
  return { distanceKm: km, inRange: kmOutside === 0, kmOutside, sunlit };
}

/**
 * The receivers that can tune `bandKhz`, best placed for `beacon` first:
 *
 * 1. Not listed as full (full ones go last rather than away: the list's
 *    counts can be 20 minutes old, as in rankReceivers).
 * 2. With a position, since nothing else here can be judged without one.
 * 3. Meeting more of the two path tests: MIN_BEACON_KM..MAX_BEACON_KM away,
 *    and a sunlit midpoint. Both beat either; either beats neither.
 * 4. Closer to that distance range (an in-range one is 0 km outside it).
 * 5. Then the usual order (byRank): listed SNR, free slots, a per-page shuffle.
 */
export function rankForBeacon(
  receivers: readonly Receiver[],
  beacon: Beacon,
  bandKhz: number,
  sun: SunPosition,
): Receiver[] {
  const fits = new Map<Receiver, BeaconFit>();
  for (const r of receivers) if (covers(r, bandKhz)) fits.set(r, beaconFit(r, beacon, bandKhz, sun));
  const met = (f: BeaconFit) => Number(f.inRange) + Number(f.sunlit);
  return [...fits.keys()].sort((a, b) => {
    const fa = fits.get(a)!;
    const fb = fits.get(b)!;
    return (
      Number(isFull(a)) - Number(isFull(b)) ||
      Number(fa.distanceKm === null) - Number(fb.distanceKm === null) ||
      met(fb) - met(fa) ||
      // Both Infinity (no position) would give NaN; they're equal here.
      (fa.kmOutside === fb.kmOutside ? 0 : fa.kmOutside - fb.kmOutside) ||
      byRank(a, b)
    );
  });
}
