import type { Broadcast } from "./eibi";
import type { BroadRegion } from "./eibi-targets";
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

/**
 * One report per listener, receiver and frequency in this long (and, for a
 * beacon, per callsign: its frequency carries a new beacon every 10 s): a
 * second answer about the same channel this soon adds nothing. The server
 * declines it (routers/reports.ts); the prompt doesn't ask about a beacon it
 * already sent an answer about in this tab, so it never thanks for one that
 * would be dropped.
 */
export const SAME_CHANNEL_MS = 30 * 60_000;

/** What a prompt asks about: the transmitter(s) and how to name them. */
export type Transmitter = {
  kind: TxKind;
  /** Stored as txName: one station, or 2–3 joined with " / ". */
  name: string;
  /** Stored as txDetail: EiBi language/target codes ("E/NAm"), for one station. */
  detail?: string;
  /** For the question: "KBS World Radio", or "anything from A, B or C". */
  label: string;
  /** Beacons: the UTC start of the 10 s slot asked about, by the server-corrected clock. */
  slotStartMs?: number;
  /** EiBi only, stored as askRule: which rules chose the station(s) asked about (ASK_RULE_VERSION). */
  askRule?: number;
  /** EiBi only, stored as askRegion: the receiver's broad region the stations were ranked by; absent when none was known. */
  askRegion?: BroadRegion;
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
 * Which rules choose the EiBi station(s) a question asks about, saved with each
 * answer as askRule so the #61 replay can tell them apart (owner, #115 review
 * D1/D2). None (null): a page from before the column, which asked about EiBi's
 * first listing. 1: with more than MAX_LISTED stations on the frequency, the one
 * aimed at the receiver's region (askRegion) is asked about; with no region
 * known that's still EiBi's first. Bump it, and say what changed here, when the
 * choice of station changes.
 */
export const ASK_RULE_VERSION = 1;

/**
 * What to ask about, from what's scheduled on the frequency: `broadcasts`
 * nearest listing first in EiBi's order (as `listedOn` returns it), `ranked`
 * the same with those aimed at where the receiver is first (`rankBroadcasts`,
 * #115). One station is named; two or three are asked about together
 * ("anything from A, B or C"); more than that, only the first ranked. Null if
 * nothing is scheduled.
 *
 * Two or three are saved (`name`) in EiBi's order whatever the ranking, so one
 * channel is always stored as the same txName; only the question (`label`)
 * follows the ranking.
 *
 * `region` is the one `ranked` was ranked by, recorded with the rule
 * (ASK_RULE_VERSION) for the #61 replay; undefined when none was known.
 */
export function eibiTransmitter(
  broadcasts: readonly Broadcast[],
  ranked: readonly Broadcast[] = broadcasts,
  region?: BroadRegion,
): Transmitter | null {
  const first = ranked[0];
  if (!first) return null;
  const rule = { askRule: ASK_RULE_VERSION, ...(region && { askRegion: region }) };
  // EiBi lists a station once per language and site; ask about each station once.
  const stations = (list: readonly Broadcast[]) => [...new Set(list.map((b) => b.station))];
  const names = stations(broadcasts);
  if (names.length >= 2 && names.length <= MAX_LISTED) {
    return {
      kind: "eibi",
      name: names.join(TX_NAME_SEPARATOR),
      label: `anything from ${orList(stations(ranked))}`,
      ...rule,
    };
  }
  return { kind: "eibi", name: first.station, detail: `${first.lang}/${first.target}`, label: first.station, ...rule };
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
 * Which of the picked beacon's slots to ask about and when (server time, ms),
 * or null if it isn't one of the 18. Only that beacon, only on its band: the
 * first of its slots there with at least BEACON_MIN_HEARD_MS played after
 * `audioStartMs` + STREAM_LATENCY_MS, asked once that slot's end has reached
 * the listener. A slot with less left is skipped; the beacon is back on the
 * band one cycle (3 minutes) later. Never before `notBeforeMs`. The report
 * carries `slotStartMs`, which the server checks against the schedule.
 */
export function beaconPromptAt(
  pick: BeaconPick,
  audioStartMs: number,
  notBeforeMs: number,
): { slotStartMs: number; askAtMs: number } | null {
  let start = turnAtOrAfter(pick, audioStartMs + STREAM_LATENCY_MS);
  if (start === null) return null;
  if (!heardEnough(start, audioStartMs)) start += CYCLE_MS;
  while (start + SLOT_MS + STREAM_LATENCY_MS < notBeforeMs) start += CYCLE_MS;
  return { slotStartMs: start, askAtMs: start + SLOT_MS + STREAM_LATENCY_MS };
}

/**
 * The start of the picked beacon's turn on its band that's on at `ms`, or
 * else its next one (server time); null if it isn't one of the 18.
 */
export function turnAtOrAfter(pick: BeaconPick, ms: number): number | null {
  const index = BEACONS.findIndex((b) => b.call === pick.call);
  if (index < 0 || IBP_BANDS_KHZ[pick.bandIndex] === undefined) return null;
  // The beacon reaches band b in its own slot plus b, in the cycle `ms` falls in.
  const slot = (index + pick.bandIndex) % BEACONS.length;
  const start = ms - (((ms % CYCLE_MS) + CYCLE_MS) % CYCLE_MS) + slot * SLOT_MS;
  return start + SLOT_MS <= ms ? start + CYCLE_MS : start;
}

/**
 * Whether the turn starting `turnStartMs` played long enough to ask about:
 * BEACON_MIN_HEARD_MS of it after first audio (`audioStartMs`, null for none
 * yet) plus STREAM_LATENCY_MS.
 */
export function heardEnough(turnStartMs: number, audioStartMs: number | null): boolean {
  if (audioStartMs === null) return false;
  const heardFrom = audioStartMs + STREAM_LATENCY_MS;
  return turnStartMs + SLOT_MS - Math.max(turnStartMs, heardFrom) >= BEACON_MIN_HEARD_MS;
}

/**
 * What the band strip says about the beacon picked with Listen, at `nowMs`
 * (server time): its turn on the picked band is on; it's next on in `inMs`;
 * or, in the gap after the first turn since the pick if that one didn't play
 * long enough to ask about (heardEnough), it was missed and is back in `inMs`.
 */
export type BeaconWatch =
  | { state: "on-air"; call: string; turnStartMs: number }
  | { state: "waiting" | "missed"; call: string; bandKhz: number; inMs: number; turnStartMs: number };

export function beaconWatch(a: {
  pick: BeaconPick;
  /** When Listen was pressed. */
  pickedAtMs: number;
  /** First audio on the picked channel, or null for none yet. */
  audioStartMs: number | null;
  nowMs: number;
}): BeaconWatch | null {
  const turn = turnAtOrAfter(a.pick, a.nowMs);
  const first = turnAtOrAfter(a.pick, a.pickedAtMs);
  if (turn === null || first === null) return null;
  const { call } = a.pick;
  if (turn <= a.nowMs) return { state: "on-air", call, turnStartMs: turn };
  const bandKhz = IBP_BANDS_KHZ[a.pick.bandIndex]!;
  const inMs = turn - a.nowMs;
  const missed = turn === first + CYCLE_MS && !heardEnough(first, a.audioStartMs);
  return { state: missed ? "missed" : "waiting", call, bandKhz, inMs, turnStartMs: turn };
}

/**
 * Why no question will follow the turn the watch line is about (`turnStartMs`:
 * the one on air, or the next), or null when one will. "off": the listener
 * closed MAX_DISMISSALS questions in this tab. "none": the prompt plans to ask
 * about another turn (the 10-minute gap between questions, or this one won't
 * have played long enough), or about none (already asked on this channel, or
 * a receiver the server keeps no reports about). `askSlotMs` is the turn the
 * prompt plans to ask about, null for none. "connecting": a receiver is still
 * connecting, with no audio yet, so the prompt has no plan and none can be
 * judged; once audio starts, the others apply.
 *
 * Between a planned turn's end and its question (STREAM_LATENCY_MS, while
 * the end of the turn reaches the listener) the line already shows the next
 * turn, but a question is on its way: null then, not "none" (#70 follow-up).
 */
export function noQuestionReason(a: {
  turnStartMs: number;
  askSlotMs: number | null;
  questionsOff: boolean;
  connecting?: boolean;
  nowMs: number;
}): "off" | "connecting" | "none" | null {
  if (a.questionsOff) return "off";
  if (a.connecting) return "connecting";
  if (a.askSlotMs === a.turnStartMs) return null;
  const asking = a.askSlotMs !== null && a.askSlotMs < a.turnStartMs;
  return asking && a.nowMs < a.askSlotMs! + SLOT_MS + STREAM_LATENCY_MS ? null : "none";
}

/** A countdown as m:ss, rounded up to the whole second (so it reads 0:01, never 0:00, before the turn). */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** What a beacon prompt asks about: "Did you hear 4X6TU …?", in the slot starting `slotStartMs`. */
export function beaconTransmitter(pick: BeaconPick, slotStartMs: number): Transmitter {
  return {
    kind: "beacon",
    name: pick.call,
    detail: String(IBP_BANDS_KHZ[pick.bandIndex]),
    label: pick.call,
    slotStartMs,
  };
}
