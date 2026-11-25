import { isFull, receiverKey, type Receiver } from "./kiwi-list";
import { BROADCAST_BANDS, HAM_BANDS } from "./radio-types";

/**
 * Each receiver's noise floor, measured by the radio service from waterfall
 * frames it already pulls (issue #67), served by its GET /noise.
 *
 * Kiwi waterfall levels are only roughly dBm and the offset differs by
 * receiver, so a receiver is compared with itself: how far this band and UTC
 * hour sit below (or above) its own median across every band. A receiver
 * that's quieter than usual here is likely the better pick right now.
 */

/** One receiver's answer from GET /noise. Levels are the waterfall's own ~1 dB steps. */
export type NoiseStat = {
  medianDb: number | null; // this band and the current UTC hour, over the last 30 days
  count: number;
  baselineDb: number | null; // every band and hour, over the last 30 days
  baselineCount: number;
};

/** GET /noise's answer: by receiverKey (host lowercased). */
export type NoiseLevels = { band: string; receivers: Record<string, NoiseStat> };

/**
 * A receiver needs this many samples for the band and hour before its noise
 * floor counts. At one sample per 10 minutes, that's five visits' worth or
 * one long session, enough that a single noisy evening doesn't decide.
 */
export const MIN_NOISE_SAMPLES = 5;

/**
 * Noise differences smaller than this are treated as equal, and the list's
 * SNR order stands. Kiwi waterfall steps are about 1 dB and a 20th-percentile
 * reading wanders by a dB or two between samples; 3 dB is half an S-unit.
 */
export const NOISE_STEP_DB = 3;

/** Receivers one GET /noise may ask about (NOISE_MAX_RECEIVERS in server.py). */
export const NOISE_MAX_RECEIVERS = 100;

/** A band the radio service measures, under its id (bc-41m, ham-40m). */
export type NoiseBand = { id: string; startKhz: number; endKhz: number };

/**
 * The radio service's band for a frequency: a broadcast band if it's in one
 * (75m sits inside 80m), else a ham band, else null. Mirrors NOISE_BANDS in
 * apps/radio/skywave_radio/noise.py.
 */
export function noiseBand(freqKhz: number): NoiseBand | null {
  const inBand = (b: { startKhz: number; endKhz: number }) => freqKhz >= b.startKhz && freqKhz <= b.endKhz;
  const bc = BROADCAST_BANDS.find(inBand);
  if (bc) return { id: `bc-${bc.name}`, startKhz: bc.startKhz, endKhz: bc.endKhz };
  const ham = HAM_BANDS.find(inBand);
  return ham ? { id: `ham-${ham.name}`, startKhz: ham.startKhz, endKhz: ham.endKhz } : null;
}

/** The key GET /noise answers under: host lowercased, as the radio service keeps it. */
export function noiseKey(r: { host: string; port: number }): string {
  return receiverKey({ host: r.host.toLowerCase(), port: r.port });
}

/**
 * How far this band and hour sit from the receiver's own baseline, in dB
 * (lower is quieter), or null when it has fewer than MIN_NOISE_SAMPLES here.
 */
export function relativeNoiseDb(stat: NoiseStat | undefined): number | null {
  if (!stat || stat.count < MIN_NOISE_SAMPLES || stat.medianDb === null || stat.baselineDb === null) return null;
  return stat.medianDb - stat.baselineDb;
}

/** `r`'s noise for `levels`' band and hour in NOISE_STEP_DB steps (lower is quieter), or null when it isn't measured enough. */
export function noiseStep(levels: NoiseLevels, r: { host: string; port: number }): number | null {
  const db = relativeNoiseDb(levels.receivers[noiseKey(r)]);
  return db === null ? null : Math.floor(db / NOISE_STEP_DB);
}

/**
 * Re-orders a ranked list (rankReceivers' order) by noise where it's known.
 *
 * Receivers with enough samples for this band and hour trade places among
 * themselves, quietest relative to their own baseline first (in NOISE_STEP_DB
 * steps; within a step the list's order stands). Receivers without enough
 * samples keep their places, so for them the list's SNR still decides. Full
 * receivers only trade with other full ones, so they stay last.
 *
 * `levels` for another band than the frequency's are ignored: the answer may
 * be for where the dial was a moment ago.
 */
export function rankByNoise(ranked: readonly Receiver[], levels: NoiseLevels | null, freqKhz: number): Receiver[] {
  const out = [...ranked];
  if (!levels || levels.band !== noiseBand(freqKhz)?.id) return out;
  const step = (r: Receiver) => noiseStep(levels, r)!;
  for (const full of [false, true]) {
    const slots = ranked
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => isFull(r) === full && relativeNoiseDb(levels.receivers[noiseKey(r)]) !== null);
    // Array.prototype.sort is stable, so ties keep the list's order.
    const quietest = slots.map(({ r }) => r).sort((a, b) => step(a) - step(b));
    slots.forEach(({ i }, k) => (out[i] = quietest[k]!));
  }
  return out;
}
