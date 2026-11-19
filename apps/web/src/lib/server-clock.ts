/**
 * The server's clock, as this browser can estimate it. A beacon slot is 10 s,
 * so a phone clock 5 s off would name the wrong beacon half the time (issue
 * #59); the IBP math reads `serverNow()` instead of `Date.now()`.
 *
 * The offset comes from the Date header of the first usable tRPC response
 * (lib/trpc.tsx). That header is in whole seconds, so this is good to about
 * half a second plus half the round trip: plenty for 10 s slots.
 *
 * It's kept against this page's monotonic clock (`performance.now()`), not
 * `Date.now()`, so setting the computer's clock back (by hand or an NTP step)
 * doesn't move the server time the page works from. Some browsers pause the
 * monotonic clock while the computer sleeps, so when the two clocks drift apart
 * by more than JUMP_MS the offset is measured again from the next quick
 * response. Until then, a forward drift (what a sleep looks like, and the
 * computer's clock kept time through it) counts from `Date.now()` with the last
 * measured offset, as the page did before the monotonic clock; a backward one
 * can't be a sleep and stays on the monotonic clock. The re-measure keeps the
 * time the page was showing unless it's more than REMEASURE_MS off, so a sleep
 * doesn't move it at all and a forward change by hand is corrected. Listeners
 * hear of every move: the first offset, a switch between the two clocks, and a
 * correction. Without a jump, later responses are ignored: an ordinary visit's
 * clock never moves under the beacon strip.
 */

/**
 * The Date header drops the milliseconds: on average the server's real time
 * was half a second past what it says.
 */
export const DATE_HEADER_ROUNDING_MS = 500;

/**
 * A response that took longer than this says little about when the server
 * wrote its Date header; wait for a quicker one.
 */
export const MAX_ROUND_TRIP_MS = 5_000;

/** How far the computer's clock must drift from the monotonic one to count as a jump (sleep, a clock change). */
export const JUMP_MS = 2_000;

/**
 * The slowest round trip a measurement after a jump may take: good to about a
 * second (half of it plus the header's rounding), so it can't move a steady
 * offset past REMEASURE_MS on its own.
 */
export const REMEASURE_ROUND_TRIP_MS = 1_000;

/** How far a measurement after a jump must move the offset to replace it; less is measurement error. */
export const REMEASURE_MS = 2_000;

/**
 * How far ahead of this browser the server's clock is, in ms, from one
 * response: its Date header against the middle of the round trip. Null when
 * the header is missing or unreadable, the response came from a cache (an Age
 * header), or the round trip was too slow to trust.
 */
export function offsetFromResponse(
  headers: { get(name: string): string | null },
  sentAt: number,
  receivedAt: number,
): number | null {
  const date = headers.get("date");
  const age = headers.get("age");
  if (!date || (age !== null && age.trim() !== "0")) return null;
  const serverMs = Date.parse(date);
  const roundTrip = receivedAt - sentAt;
  if (!Number.isFinite(serverMs) || roundTrip < 0 || roundTrip > MAX_ROUND_TRIP_MS) return null;
  return serverMs + DATE_HEADER_ROUNDING_MS - (sentAt + roundTrip / 2);
}

/** The computer's clock less the monotonic one: steady until the computer sleeps or its clock is changed. */
const wallLessMono = () => Date.now() - performance.now();

/** Server time less `performance.now()`, or null before a measurement. */
let monoOffset: number | null = null;
/** wallLessMono() when the offset was last measured. */
let measuredAt = 0;
/** Whether serverNow() last counted from the computer's clock (a forward jump not yet measured). */
let onWallClock = false;
const listeners = new Set<() => void>();

/** How far the computer's clock has moved ahead of the monotonic one since the offset was measured. */
const drift = () => wallLessMono() - measuredAt;

/** A forward jump not yet measured: serverNow() counts from the computer's clock. */
const wallClockNow = () => monoOffset !== null && drift() > JUMP_MS;

/** Tells every listener; one that throws can't stop the rest or fail the request that measured. */
function notify() {
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      console.error("server-clock: listener failed", e);
    }
  }
}

/** Whether serverNow() has switched clocks since it last looked; records the switch. */
function switched(): boolean {
  const now = wallClockNow();
  if (now === onWallClock) return false;
  onWallClock = now;
  return true;
}

/**
 * Records the offset from a response (`sentAt` and `receivedAt` by
 * `Date.now()`): the first usable one, and after a jump a quick one, which
 * keeps the time shown unless it's more than REMEASURE_MS off.
 */
export function noteResponse(headers: { get(name: string): string | null }, sentAt: number, receivedAt: number) {
  if (monoOffset !== null) {
    if (Math.abs(drift()) <= JUMP_MS) return;
    if (receivedAt - sentAt > REMEASURE_ROUND_TRIP_MS) return;
  }
  const o = offsetFromResponse(headers, sentAt, receivedAt);
  if (o === null) return;
  const next = o + wallLessMono();
  const first = monoOffset === null;
  // A switch to the computer's clock that nothing has noticed yet still moved the time shown.
  const moved = switched();
  const shown = serverNow() - performance.now();
  measuredAt = wallLessMono();
  // Within REMEASURE_MS of the time shown is measurement error: keep showing it,
  // so leftover error never piles up across jumps.
  monoOffset = first || Math.abs(next - shown) > REMEASURE_MS ? next : shown;
  onWallClock = false;
  if (first || moved || Math.abs(monoOffset - shown) > REMEASURE_MS) notify();
}

/** The server's time now, in ms since the epoch: this browser's clock until an offset is known. */
export function serverNow(): number {
  if (monoOffset === null) return Date.now();
  // Listeners hear of a switch between the clocks after the caller is done with this value.
  if (switched()) queueMicrotask(notify);
  // A forward jump not yet measured: the computer's clock with the last offset.
  if (onWallClock) return Date.now() + monoOffset - measuredAt;
  return performance.now() + monoOffset;
}

/** How far ahead of this browser's clock the server's is now, or null before one is known. */
export function serverOffset(): number | null {
  if (monoOffset === null) return null;
  return serverNow() - Date.now();
}

/**
 * Whether serverNow() isn't counting from the computer's clock through a
 * forward jump (a sleep or a change by hand) it hasn't re-measured.
 */
export function serverClockSettled(): boolean {
  return !wallClockNow();
}

/** Calls `listener` when the time the page works from moves: the first offset, a switch between clocks, or a correction; returns the unsubscribe. */
export function onServerOffset(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * `fetch`, noting the server's clock from each usable response (noteResponse
 * decides which count). Given to the tRPC links, so whichever request answers
 * first sets the offset.
 */
export const clockedFetch: typeof fetch = async (input, init) => {
  const sentAt = Date.now();
  const res = await fetch(input, init);
  noteResponse(res.headers, sentAt, Date.now());
  return res;
};

/** For tests: forget the offset. */
export function resetServerClock() {
  monoOffset = null;
  measuredAt = 0;
  onWallClock = false;
}
