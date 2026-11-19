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

/**
 * Which rules made a report's context, stored with it as pickVersion so the
 * replay can tell them apart. None (null): PR #73, before the edge-case fixes
 * (a stale question could take a later run's context, case-variant hosts and
 * looser server checks); a tab loaded before a deploy keeps sending that
 * until reloaded. 2: those fixes (PR #74). 3: round 2, where an answer keeps
 * its question's context only if no choice was dropped since the question
 * appeared (a dial move away and back no longer keeps it), a beacon Listen
 * with no receiver list drops the earlier choice, and candidates must be
 * canonical. 4: the clock behind `pickedAtMs` counts from this page's
 * monotonic clock and is measured again after the computer's clock jumps
 * (lib/server-clock.ts), and a beacon question starts its plan over when the
 * offset changes. 5: a re-measure keeps the time shown unless it's over 2 s
 * off, every switch between the page's two clocks re-plans the beacon
 * question, a question whose turn is too old to be taken isn't asked, and a
 * pick made through a forward clock jump not yet re-measured keeps no
 * context. The server still accepts 2 to 4 from tabs opened before those
 * deploys.
 * Raise it whenever what the page records, or when it records it, changes.
 */
export const PICK_CONTEXT_VERSION = 5;

/** How many of the ranked list's receivers a report keeps, best first. */
export const MAX_CANDIDATES = 10;

/**
 * The most users a pick records; the list's own count has no upper bound, and
 * an operator's odd value mustn't cost the whole context (reports.submit
 * refuses more).
 */
export const MAX_USERS = 1_000;

export type PickContext = {
  /** PICK_CONTEXT_VERSION when it was made. */
  version: number;
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
    version: PICK_CONTEXT_VERSION,
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
