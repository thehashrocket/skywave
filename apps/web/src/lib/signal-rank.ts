/**
 * Which receivers to try for a signal station (issue #99): by the path from
 * its transmitter, like rankForBeacon does for the IBP beacons. Pure; the page
 * passes the result to Pick best, which works down it.
 *
 * These stations are mostly high-power, on 3-10 MHz, so the rules differ from
 * the beacons': below about 8 MHz a path wants darkness at its midpoint (the
 * D layer soaks up low frequencies in daylight), above about 10 MHz it wants
 * daylight as the beacons do, and close-in receivers count on the low bands,
 * where signals come almost straight down (NVIS) and get through by day too.
 */

import { distanceKm, kmOutsideRange, midpoint } from "./great-circle";
import { byRank, covers, isFull, type Receiver } from "./kiwi-list";
import { noiseBand, noiseStep, type NoiseLevels } from "./noise-rank";
import type { Transmitter } from "./signal-stations";
import { NIGHT_ELEVATION, sunElevation, type SunPosition } from "./solar";

/** Below this a path wants a dark midpoint. */
export const NIGHT_BELOW_KHZ = 8_000;
/**
 * Below NIGHT_BELOW_KHZ, a receiver this close passes the light test day or
 * night: the signal comes down almost vertically (NVIS) on a short path the
 * daytime D layer doesn't close (owner, #99 review 2026-11-25). Without it a
 * distant dark path would outrank a nearby receiver at midday.
 */
export const NVIS_KM = 800;
/** At and above this a path wants a sunlit midpoint, like the beacons' bands. */
export const DAY_FROM_KHZ = 10_000;
/** Farther than this takes three or more hops; the station rarely makes it. */
export const MAX_SIGNAL_KM = 8_000;
/** Nearer than this is usually inside the skip zone, from DAY_FROM_KHZ up (as MIN_BEACON_KM). */
export const SKIP_KM = 1_000;

/**
 * How far the distance range stretches for a transmitter position we're unsure
 * of: a country-level position can be off by a country's width, so a receiver
 * just outside the range may really be inside it.
 */
export const SLACK_KM: Record<Transmitter["confidence"], number> = { known: 0, approx: 300, country: 1_500 };

/** How one receiver sits for a station. Distance is null without a position. */
export type SignalFit = {
  distanceKm: number | null;
  /** Within the frequency's distance range, allowing the position's slack. */
  inRange: boolean;
  /** How far outside that range, in km; 0 inside it, Infinity without a position. */
  kmOutside: number;
  /** The midpoint's light suits the frequency (always true from NIGHT_BELOW_KHZ to DAY_FROM_KHZ, and within NVIS_KM below it). */
  lightOk: boolean;
};

export function signalFit(r: Receiver, tx: Transmitter, khz: number, sun: SunPosition): SignalFit {
  if (r.lat === undefined || r.lon === undefined) return { distanceKm: null, inRange: false, kmOutside: Infinity, lightOk: false };
  const at = { lat: r.lat, lon: r.lon };
  const km = distanceKm(tx, at);
  const slack = SLACK_KM[tx.confidence];
  const skip = khz >= DAY_FROM_KHZ ? SKIP_KM : 0;
  const kmOutside = kmOutsideRange(km, Math.max(0, skip - slack), MAX_SIGNAL_KM + slack);
  const mid = midpoint(tx, at);
  const sunlit = sunElevation(mid.lat, mid.lon, sun) >= NIGHT_ELEVATION;
  let lightOk = true;
  if (khz < NIGHT_BELOW_KHZ) lightOk = !sunlit || km <= NVIS_KM;
  else if (khz >= DAY_FROM_KHZ) lightOk = sunlit;
  return { distanceKm: km, inRange: kmOutside === 0, kmOutside, lightOk };
}

/**
 * The receivers that can tune `khz`, best placed for a station sent from `tx` first:
 *
 * 1. Not listed as full (full ones go last rather than away, as in rankForBeacon).
 * 2. With a position.
 * 3. Meeting more of the two path tests: in the distance range, and the
 *    midpoint's light suiting the frequency. Both beat either; either beats neither.
 * 4. Closer to the distance range; for a country-level position, whose
 *    distance is rough, only in steps of its 1,500 km slack.
 * 5. Quieter for this band and hour relative to its own baseline (noise-rank's
 *    steps), when measured; an unmeasured receiver counts as at its baseline.
 *    Noise only breaks ties here, so it never lifts a receiver past a better path.
 *    The radio service measures broadcast and ham bands only, so many signal
 *    frequencies (4625 kHz, say) have no noise data and skip this step.
 * 6. Then the usual order (byRank).
 */
export function rankForSignal(
  receivers: readonly Receiver[],
  tx: Transmitter,
  khz: number,
  sun: SunPosition,
  noise: NoiseLevels | null = null,
): Receiver[] {
  const fits = new Map<Receiver, SignalFit>();
  for (const r of receivers) if (covers(r, khz)) fits.set(r, signalFit(r, tx, khz, sun));
  const met = (f: SignalFit) => Number(f.inRange) + Number(f.lightOk);
  const levels = noise && noise.band === noiseBand(khz)?.id ? noise : null;
  // An unmeasured receiver counts as at its own baseline (step 0).
  const quietness = (r: Receiver) => (levels && noiseStep(levels, r)) ?? 0;
  // A country-level position is too rough to order by the kilometre, so its
  // distances count in steps of its slack: far beats very far, near ties with nearer.
  const distanceOrder = (km: number) =>
    tx.confidence === "country" ? Math.floor(km / SLACK_KM.country) : km;
  return [...fits.keys()].sort((a, b) => {
    const fa = fits.get(a)!;
    const fb = fits.get(b)!;
    return (
      Number(isFull(a)) - Number(isFull(b)) ||
      Number(fa.distanceKm === null) - Number(fb.distanceKm === null) ||
      met(fb) - met(fa) ||
      // Both Infinity (no position) would give NaN; they're equal here.
      (fa.kmOutside !== fb.kmOutside ? distanceOrder(fa.kmOutside) - distanceOrder(fb.kmOutside) : 0) ||
      quietness(a) - quietness(b) ||
      byRank(a, b)
    );
  });
}
