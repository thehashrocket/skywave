/**
 * The server's clock, as this browser can estimate it. A beacon slot is 10 s,
 * so a phone clock 5 s off would name the wrong beacon half the time (issue
 * #59); the IBP math reads `serverNow()` instead of `Date.now()`.
 *
 * The offset comes once, from the Date header of the first usable tRPC
 * response (lib/trpc.tsx). That header is in whole seconds, so this is good to
 * about half a second plus half the round trip: plenty for 10 s slots.
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

let offset: number | null = null;
const listeners = new Set<() => void>();

/** Records the offset from a response, if none is known yet. Later responses are ignored. */
export function noteResponse(headers: { get(name: string): string | null }, sentAt: number, receivedAt: number) {
  if (offset !== null) return;
  const o = offsetFromResponse(headers, sentAt, receivedAt);
  if (o === null) return;
  offset = o;
  for (const l of listeners) l();
}

/** The server's time now, in ms since the epoch: this browser's clock until an offset is known. */
export function serverNow(): number {
  return Date.now() + (offset ?? 0);
}

/** The offset in use, or null before one is known. */
export function serverOffset(): number | null {
  return offset;
}

/** Calls `listener` when the offset becomes known; returns the unsubscribe. */
export function onServerOffset(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * `fetch`, noting the server's clock from the first usable response. Given to
 * the tRPC links, so whichever request answers first sets the offset.
 */
export const clockedFetch: typeof fetch = async (input, init) => {
  const sentAt = Date.now();
  const res = await fetch(input, init);
  noteResponse(res.headers, sentAt, Date.now());
  return res;
};

/** For tests: forget the offset. */
export function resetServerClock() {
  offset = null;
}
