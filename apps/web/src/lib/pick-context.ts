import { receiverKey, type Receiver } from "./kiwi-list";

/**
 * How Pick best came to choose the receiver a reception report is about
 * (issue #61): stored beside the answer so a later replay can compare
 * "spots near this receiver" with the order Pick best really walked, using
 * only what existed when it chose. Owner decisions D5/D6 (2026-11-18).
 */

/** Which button started the run. "better" lists the offered receiver first by hand, not by rank. */
export const PICK_SOURCES = ["beacon", "listen", "link", "drawer", "better"] as const;
export type PickSource = (typeof PICK_SOURCES)[number];

/** How many of the ranked list's receivers a report keeps, best first. */
export const MAX_CANDIDATES = 10;

/**
 * The most users a pick records; the list's own count has no upper bound, and
 * an operator's odd value mustn't cost the whole context (reports.submit
 * refuses more).
 */
export const MAX_USERS = 1_000;

export type PickContext = {
  /** When Pick best tuned this receiver, by the server's clock (serverNow). */
  pickedAtMs: number;
  pickSource: PickSource;
  /** Its place in the ranked list the run was given, from 0; can be MAX_CANDIDATES or more. */
  rankPos: number;
  /** The first MAX_CANDIDATES of that list, as receiverKey (host:port, host lowercased). */
  candidates: string[];
  /** The dial when the run started: the list was ranked for this frequency. */
  freqKhz: number;
  /** From the public list at pick time, which refetches every 15 minutes. */
  lat?: number;
  lon?: number;
  snr: number | null;
  users: number;
};

/** The key a report names a receiver by: host lowercased, as reports.submit stores it. */
export const pickKey = (r: { host: string; port: number }) => receiverKey({ host: r.host.toLowerCase(), port: r.port });

/** The context for `chosen`, the receiver a run is about to tune from `ranked`. */
export function pickContext(
  ranked: readonly Receiver[],
  chosen: Receiver,
  pickSource: PickSource,
  freqKhz: number,
  pickedAtMs: number,
): PickContext {
  const key = pickKey(chosen);
  return {
    // serverNow() carries half a millisecond when the clock offset came from an
    // odd round trip; the server takes whole milliseconds only.
    pickedAtMs: Math.round(pickedAtMs),
    pickSource,
    rankPos: ranked.findIndex((r) => pickKey(r) === key),
    candidates: ranked.slice(0, MAX_CANDIDATES).map(pickKey),
    freqKhz,
    ...(chosen.lat !== undefined && chosen.lon !== undefined && { lat: chosen.lat, lon: chosen.lon }),
    snr: chosen.snr,
    users: Math.min(chosen.users, MAX_USERS),
  };
}
