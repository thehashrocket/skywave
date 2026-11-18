import type { Broadcast } from "./eibi";
import { BEACONS, CYCLE_MS, IBP_BANDS_KHZ, SLOT_MS } from "./ibp";

/**
 * Reception reports (issue #60): "Did you hear it?" about a known transmitter
 * on the receiver and frequency being listened to. Shared by the prompt and
 * the server's `reports` router.
 */

/** Heard it, didn't, or the receiver itself didn't open (no audio worth judging). */
export const OUTCOMES = ["heard", "not_heard", "no_open"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * What a report is about: an EiBi listing, or an IBP beacon (#59) with its
 * callsign as the name and its band as the detail. The column is text, so a
 * new kind needs no migration.
 */
export const TX_KINDS = ["eibi", "beacon"] as const;
export type TxKind = (typeof TX_KINDS)[number];

/** The longest comment kept, in characters. */
export const COMMENT_MAX = 280;

/**
 * How far back the server still counts a listing as the one asked about
 * (routers/reports.ts). The prompt comes after a minute's listening and may
 * sit a while before it's answered, so a broadcast that ended a few minutes
 * ago is still a fair answer. The prompt closes itself before this runs out.
 */
export const LISTING_GRACE_MS = 5 * 60_000;

/** What a prompt asks about: the transmitter(s) and how to name them. */
export type Transmitter = {
  kind: TxKind;
  /** Stored as txName: one station, or 2–3 joined with " / ". */
  name: string;
  /** Stored as txDetail: EiBi language/target codes ("E/NAm"), for one station. */
  detail?: string;
  /** For the question: "KBS World Radio", or "anything from A, B or C". */
  label: string;
};

/** Up to this many stations sharing a frequency are asked about together. */
export const MAX_LISTED = 3;

/**
 * Joins the stations asked about together in txName. No EiBi station name
 * contains it, so the server splits on it to check each one is scheduled.
 */
export const TX_NAME_SEPARATOR = " / ";

/** "A", "A or B", "A, B or C". */
function orList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/**
 * What to ask about, from what's scheduled on the frequency (nearest listing
 * first, as `scheduledOn` returns it). One station is named; two or three are
 * asked about together ("anything from A, B or C"); more than that, only the
 * nearest listing. Null if nothing is scheduled.
 */
export function eibiTransmitter(broadcasts: readonly Broadcast[]): Transmitter | null {
  const first = broadcasts[0];
  if (!first) return null;
  // EiBi lists a station once per language and site; ask about each station once.
  const names = [...new Set(broadcasts.map((b) => b.station))];
  if (names.length >= 2 && names.length <= MAX_LISTED) {
    return { kind: "eibi", name: names.join(TX_NAME_SEPARATOR), label: `anything from ${orList(names)}` };
  }
  return { kind: "eibi", name: first.station, detail: `${first.lang}/${first.target}`, label: first.station };
}

/**
 * How far the receiver's audio trails the air: the KiwiSDR stream plus the
 * page's buffering, about a second or two. A beacon slot only counts as heard
 * from first audio plus this, and the prompt waits this long past its end.
 */
export const STREAM_LATENCY_MS = 1_500;

/**
 * How much of a beacon's 10 s slot must have played, counted from first audio
 * plus STREAM_LATENCY_MS, before the listener is asked about it: the callsign
 * at 22 WPM and the dashes take most of the slot (owner's rule, issue #59).
 */
export const BEACON_MIN_HEARD_MS = 7_000;

/** The beacon the listener chose with Listen on the band strip, and the band it was chosen on. */
export type BeaconPick = { call: string; bandIndex: number };

/**
 * When to ask about the beacon picked with Listen (server time, ms), or null
 * if it isn't one of the 18. Only that beacon, only on its band: the first of
 * its slots there with at least BEACON_MIN_HEARD_MS played after
 * `audioStartMs` + STREAM_LATENCY_MS, asked once that slot's end has reached
 * the listener. A slot with less left is skipped; the beacon is back on the
 * band one cycle (3 minutes) later. Never before `notBeforeMs`.
 */
export function beaconPromptAt(pick: BeaconPick, audioStartMs: number, notBeforeMs: number): number | null {
  const index = BEACONS.findIndex((b) => b.call === pick.call);
  if (index < 0 || IBP_BANDS_KHZ[pick.bandIndex] === undefined) return null;
  const heardFrom = audioStartMs + STREAM_LATENCY_MS;
  // The beacon's slot on this band, in the cycle `heardFrom` falls in.
  const slot = (index + pick.bandIndex) % BEACONS.length;
  let start = heardFrom - (((heardFrom % CYCLE_MS) + CYCLE_MS) % CYCLE_MS) + slot * SLOT_MS;
  if (start + SLOT_MS <= heardFrom) start += CYCLE_MS;
  if (start + SLOT_MS - Math.max(start, heardFrom) < BEACON_MIN_HEARD_MS) start += CYCLE_MS;
  while (start + SLOT_MS + STREAM_LATENCY_MS < notBeforeMs) start += CYCLE_MS;
  return start + SLOT_MS + STREAM_LATENCY_MS;
}

/** What a beacon prompt asks about: "Did you hear 4X6TU …?" */
export function beaconTransmitter(pick: BeaconPick): Transmitter {
  return { kind: "beacon", name: pick.call, detail: String(IBP_BANDS_KHZ[pick.bandIndex]), label: pick.call };
}
