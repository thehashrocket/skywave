/**
 * The server's clock, as this browser can estimate it. A beacon slot is 10 s,
 * so a phone clock 5 s off would name the wrong beacon half the time (issue
 * #59); the IBP math reads `serverNow()` instead of `Date.now()`.
 *
 * Measuring: every tRPC response carries the server's time in milliseconds
 * (SERVER_MS_HEADER, set by the tRPC route), read against the middle of the
 * round trip, so a measurement is good to half the round trip. A response
 * without it (an error page, the password gate) falls back to the Date header,
 * whole seconds, good to half a second more. Cached responses (an Age header)
 * and slow ones don't count.
 *
 * Keeping time: the offset is kept against this page's monotonic clock
 * (`performance.now()`), so setting the computer's clock back doesn't move
 * it. Some browsers pause the monotonic clock while the computer sleeps, so a
 * forward drift past JUMP_MS between the two (what a sleep looks like; the
 * computer's clock kept time through it) counts from `Date.now()` with the last
 * offset until a measurement, and goes back only once the drift is under
 * LEAVE_WALL_CLOCK_MS, so jitter at the edge can't flap.
 *
 * Re-measuring: on a switch to the computer's clock (again every
 * REMEASURE_RETRY_MS until one lands), every REMEASURE_EVERY_MS while the tab
 * is visible, and when it becomes visible, so a backward change, a sleep the
 * page didn't see, slow drift between the two clocks and a slow first
 * measurement are all caught. A measurement within its error of the time
 * shown keeps that time (a sleep moves nothing); a larger difference is a
 * correction and the measurement is taken. On an ordinary visit (no jump, and
 * the time shown already measured well) only an error of
 * ORDINARY_CORRECTION_MS or more is corrected, so the clock almost never
 * shifts under a planned beacon question.
 *
 * Listeners hear of every move: the first offset, a switch between the two
 * clocks, and a correction. serverClockCorrections() counts corrections (and
 * a jump undone before any measurement), so something recorded on the page's
 * time can tell whether that time was later found wrong.
 */

/** The response header that carries the server's time in ms since the epoch (set by the tRPC route). */
export const SERVER_MS_HEADER = "x-server-ms";

/**
 * The Date header drops the milliseconds: on average the server's real time
 * was half a second past what it says.
 */
export const DATE_HEADER_ROUNDING_MS = 500;

/** The slowest response the first measurement may come from: it beats having none. */
export const MAX_ROUND_TRIP_MS = 5_000;

/**
 * The slowest response a later measurement may come from, unless it measures
 * better than the clock is known to (a slow link) or the page is counting
 * from the computer's clock (any measurement beats none).
 */
export const QUICK_ROUND_TRIP_MS = 1_000;

/** How far the computer's clock must drift ahead of the monotonic one to count as a jump (a sleep, a clock change). */
export const JUMP_MS = 2_000;

/** Back to the monotonic clock only once the drift falls under this, so the edge can't flap. */
export const LEAVE_WALL_CLOCK_MS = 1_000;

/**
 * The least a measurement must differ from the time shown to correct it; less
 * is noise, and every correction re-plans a beacon question.
 */
export const MIN_CORRECTION_MS = 500;

/**
 * The least an ordinary visit's clock (no jump, the time shown measured to
 * within MIN_CORRECTION_MS) is corrected by: smaller errors don't name the
 * wrong beacon and aren't worth re-planning a question for (owner).
 */
export const ORDINARY_CORRECTION_MS = 1_500;

/** How often the page measures the server's clock while the tab is visible. */
export const REMEASURE_EVERY_MS = 5 * 60_000;

/** How soon the page asks again while counting from the computer's clock, or after a slow first measurement. */
export const REMEASURE_RETRY_MS = 10_000;

/** How soon the page asks again after an ordinary ask that failed or came back slow. */
export const REMEASURE_BACKOFF_MS = 60_000;

/** An ask that hasn't answered by then is given up on. */
export const REMEASURE_TIMEOUT_MS = 5_000;

/** How long a visible-again tab can go unmeasured before it asks. */
export const VISIBLE_REMEASURE_MS = 30_000;

/**
 * Where the page asks. It must reach the tRPC route handler, which answers
 * every request fresh with SERVER_MS_HEADER (a HEAD gets an empty 204 before
 * any procedure runs): a bare /api/trpc matches no route, and its not-found
 * page comes from a cache with an Age header.
 */
export const REMEASURE_PATH = "/api/trpc/clock";

/** One response's reading of the server's lead over this browser's clock, and how far off it can be. */
export type Measurement = { offset: number; error: number };

/**
 * What one response says about the server's clock (`sentAt` and `receivedAt`
 * by `Date.now()`), or null when it can't be trusted: no time header, an Age
 * header (a cached copy), or a round trip that ran backwards or past
 * MAX_ROUND_TRIP_MS.
 */
export function measureFromResponse(
  headers: { get(name: string): string | null },
  sentAt: number,
  receivedAt: number,
): Measurement | null {
  const age = headers.get("age");
  if (age !== null && age.trim() !== "0") return null;
  const roundTrip = receivedAt - sentAt;
  if (roundTrip < 0 || roundTrip > MAX_ROUND_TRIP_MS) return null;
  const middle = sentAt + roundTrip / 2;
  const precise = headers.get(SERVER_MS_HEADER);
  if (precise !== null) {
    const serverMs = Number(precise);
    if (Number.isFinite(serverMs) && serverMs > 0) return { offset: serverMs - middle, error: roundTrip / 2 };
  }
  const date = headers.get("date");
  if (!date) return null;
  const serverMs = Date.parse(date);
  if (!Number.isFinite(serverMs)) return null;
  return { offset: serverMs + DATE_HEADER_ROUNDING_MS - middle, error: DATE_HEADER_ROUNDING_MS + roundTrip / 2 };
}

/** The server's lead from one response, or null (measureFromResponse without the error). */
export function offsetFromResponse(
  headers: { get(name: string): string | null },
  sentAt: number,
  receivedAt: number,
): number | null {
  return measureFromResponse(headers, sentAt, receivedAt)?.offset ?? null;
}

/** The computer's clock less the monotonic one: steady until the computer sleeps or its clock is changed. */
const wallLessMono = () => Date.now() - performance.now();

/** Server time less `performance.now()`, or null before a measurement. */
let monoOffset: number | null = null;
/** How far off monoOffset can be, from the measurement it came from. */
let offsetError = Infinity;
/** wallLessMono() when the clock was last measured. */
let measuredAt = 0;
/** performance.now() when the clock was last measured. */
let measuredPerf = -Infinity;
/** Whether serverNow() last counted from the computer's clock (a forward jump not yet measured). */
let onWallClock = false;
/** drift() when serverNow() last told listeners about the computer's clock (the switch to it, or a further jump). */
let wallDrift = 0;
/** Times the time shown was found wrong: a correction, or a jump undone before any measurement. */
let corrections = 0;
/** Measurable replies since the clock was last unmeasured or switched to the computer's clock. */
let replies = 0;
/** Whether remeasure() is waiting on an answer. */
let asking = false;
let nextAsk: ReturnType<typeof setTimeout> | undefined;
let watching = false;
const listeners = new Set<() => void>();
/** Callers of settleServerClock() waiting for a measurement. */
const settleWaiters = new Set<() => void>();

/** How far the computer's clock has moved ahead of the monotonic one since the clock was measured. */
const drift = () => wallLessMono() - measuredAt;

/** A forward jump not yet measured: serverNow() counts from the computer's clock. */
const wallClockNow = () => monoOffset !== null && drift() > (onWallClock ? LEAVE_WALL_CLOCK_MS : JUMP_MS);

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

function settled() {
  for (const resolve of settleWaiters) resolve();
  settleWaiters.clear();
}

/**
 * Whether serverNow() has switched clocks since it last looked; records the
 * switch. Leaving the computer's clock without a measurement means the jump
 * was undone (a change by hand put back), so the time shown meanwhile was wrong.
 */
function switched(): boolean {
  const now = wallClockNow();
  if (now === onWallClock) return false;
  onWallClock = now;
  if (now) replies = 0;
  if (!now) {
    corrections++;
    settled();
  }
  return true;
}

/**
 * Records what a response says about the server's clock: the first usable
 * one, and later any quick one. It corrects the time shown only when it
 * differs by more than both readings' error and MIN_CORRECTION_MS.
 */
export function noteResponse(headers: { get(name: string): string | null }, sentAt: number, receivedAt: number) {
  const m = measureFromResponse(headers, sentAt, receivedAt);
  if (m === null) return;
  const first = monoOffset === null;
  const slow = receivedAt - sentAt > QUICK_ROUND_TRIP_MS;
  if (!first && slow && !wallClockNow() && m.error >= offsetError) {
    // Not a better measurement, but the link was asked again: it's this slow.
    replies++;
    return;
  }
  // A switch to the computer's clock nothing had noticed yet still moved the time shown.
  const moved = switched();
  replies++;
  const wlm = wallLessMono();
  const next = m.offset + wlm;
  // The time shown, as an offset from performance.now().
  const shown = monoOffset === null ? wlm : onWallClock ? monoOffset + wlm - measuredAt : monoOffset;
  // After a jump, or while the time shown is poorly measured, fix any real error;
  // on an ordinary visit only one that matters.
  const least = onWallClock || offsetError > MIN_CORRECTION_MS ? MIN_CORRECTION_MS : ORDINARY_CORRECTION_MS;
  const band = Math.max(least, m.error + Math.min(offsetError, m.error));
  const corrected = Math.abs(next - shown) > band;
  if (first || corrected) {
    monoOffset = next;
    offsetError = m.error;
  } else {
    monoOffset = shown;
    // The time shown is now known to within this.
    offsetError = Math.min(offsetError, Math.abs(next - shown) + m.error);
  }
  measuredAt = wlm;
  measuredPerf = performance.now();
  onWallClock = false;
  if (corrected) corrections++;
  if (first || moved || corrected) notify();
  settled();
  if (first) watchVisibility();
  // A slow first measurement is worth bettering soon; otherwise the next is due on schedule.
  if (!asking) scheduleAsk(first && slow ? REMEASURE_RETRY_MS : REMEASURE_EVERY_MS);
}

/** The server's time now, in ms since the epoch: this browser's clock until an offset is known. */
export function serverNow(): number {
  if (monoOffset === null) return Date.now();
  const sw = switched();
  // Another jump while already on the computer's clock (a second sleep, a change
  // by hand) moves the time as much as a switch does.
  const further = !sw && onWallClock && Math.abs(drift() - wallDrift) > JUMP_MS;
  if (sw || further) {
    // Listeners hear of it after the caller is done with this value.
    queueMicrotask(notify);
    // On the computer's clock: measure now, so a change by hand is corrected
    // before anything the page records on it reaches the server.
    if (onWallClock) {
      wallDrift = drift();
      remeasure();
    }
  }
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
 * Whether serverNow() is measured as well as this link allows (to within
 * QUICK_ROUND_TRIP_MS, or asked again at least once, so a slow link settles
 * on its best) and not counting from the computer's clock through a forward
 * jump (a sleep or a change by hand) it hasn't re-measured.
 */
export function serverClockSettled(): boolean {
  return monoOffset !== null && (offsetError <= QUICK_ROUND_TRIP_MS || replies >= 2) && !wallClockNow();
}

/**
 * How many times the time shown was found wrong: a correction, or a jump
 * undone before any measurement. Something recorded on serverNow() whose count
 * has moved since was recorded on a time now known to be off.
 */
export function serverClockCorrections(): number {
  return corrections;
}

/**
 * Resolves once the clock is settled (asking the server if need be), or after
 * `timeoutMs` without one, so a caller can wait briefly before recording the
 * time; check serverClockSettled() after.
 */
export function settleServerClock(timeoutMs = 2 * QUICK_ROUND_TRIP_MS): Promise<void> {
  serverNow();
  if (serverClockSettled()) return Promise.resolve();
  remeasure();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      settleWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    settleWaiters.add(done);
  });
}

/** Calls `listener` when the time the page works from moves: the first offset, a switch between clocks, or a correction; returns the unsubscribe. */
export function onServerOffset(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * `fetch`, noting the server's clock from each usable response (noteResponse
 * decides which count). Given to the tRPC links, so every request measures.
 */
export const clockedFetch: typeof fetch = async (input, init) => {
  // The round trip on the monotonic clock: setting the computer's clock while
  // the request is out can't shorten it or skew its middle.
  const sentPerf = performance.now();
  const res = await fetch(input, init);
  const receivedAt = Date.now();
  noteResponse(res.headers, receivedAt - (performance.now() - sentPerf), receivedAt);
  return res;
};

function scheduleAsk(ms: number) {
  if (typeof window === "undefined") return;
  clearTimeout(nextAsk);
  nextAsk = setTimeout(() => {
    if (document.visibilityState === "visible") remeasure();
    else scheduleAsk(REMEASURE_EVERY_MS);
  }, ms);
}

/**
 * Asks the server for its time with a HEAD (no data touched), one ask at a
 * time, given up after REMEASURE_TIMEOUT_MS. Without a measurement it asks
 * again in REMEASURE_RETRY_MS while counting from the computer's clock, else
 * in REMEASURE_BACKOFF_MS.
 */
function remeasure() {
  if (typeof window === "undefined" || asking) return;
  asking = true;
  const before = measuredPerf;
  const abort = new AbortController();
  const giveUp = setTimeout(() => abort.abort(), REMEASURE_TIMEOUT_MS);
  clockedFetch(REMEASURE_PATH, { method: "HEAD", cache: "no-store", signal: abort.signal })
    .catch(() => {})
    .finally(() => {
      clearTimeout(giveUp);
      asking = false;
      const measured = measuredPerf !== before;
      scheduleAsk(measured ? REMEASURE_EVERY_MS : onWallClock ? REMEASURE_RETRY_MS : REMEASURE_BACKOFF_MS);
    });
}

/** Measures when the tab comes back into view after a while, the moment a sleep or a long background stint ends. */
function watchVisibility() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    serverNow();
    if (performance.now() - measuredPerf >= VISIBLE_REMEASURE_MS) remeasure();
  });
}

/** For tests: forget the offset and any pending ask. */
export function resetServerClock() {
  monoOffset = null;
  offsetError = Infinity;
  measuredAt = 0;
  measuredPerf = -Infinity;
  onWallClock = false;
  wallDrift = 0;
  corrections = 0;
  replies = 0;
  asking = false;
  clearTimeout(nextAsk);
  nextAsk = undefined;
  settleWaiters.clear();
}
