import type { Broadcast } from "./eibi";

/**
 * Reception reports (issue #60): "Did you hear it?" about a known transmitter
 * on the receiver and frequency being listened to. Shared by the prompt and
 * the server's `reports` router.
 */

/** Heard it, didn't, or the receiver itself didn't open (no audio worth judging). */
export const OUTCOMES = ["heard", "not_heard", "no_open"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * What a report is about. Only EiBi listings for now; beacons (#59) will add
 * "beacon", with the callsign as the name. The column is text, so that needs
 * no migration.
 */
export type TxKind = "eibi" | "beacon";

/** The longest comment kept, in characters. */
export const COMMENT_MAX = 280;

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
const MAX_LISTED = 3;

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
    return { kind: "eibi", name: names.join(" / "), label: `anything from ${orList(names)}` };
  }
  return { kind: "eibi", name: first.station, detail: `${first.lang}/${first.target}`, label: first.station };
}
