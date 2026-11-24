/**
 * UTC and local time labels shared by the header clock (#106), the tuning
 * bar's clock, the saved-frequency stamps (#107) and the GhostNet strip.
 *
 * Two time styles on purpose (#106/#107): the live clocks write HH:MM:SS or
 * HH:MM with colons, like a clock face; the saved stamp writes HHMM
 * ("2214 UTC"), the radio-schedule style the GhostNet strip uses. The clock
 * and the stamps take their UTC dates ("Mon 23 Nov", "8 Nov", "8 Nov 2025")
 * from utcDate, so they never disagree on how a day is written.
 *
 * Not to be confused with `utcDay` in lib/rbn.ts, which is an RBN file's day
 * key ("2026-11-27").
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60_000;
/** How far ahead of "now" a save may be and still read as this week: the list's minute tick plus clock slack. */
const AHEAD_SLACK_MS = 5 * 60_000;
const pad = (n: number) => String(n).padStart(2, "0");
/** The UTC hour and minute, two digits each. */
const hourMinute = (ms: number) => {
  const d = new Date(ms);
  return [pad(d.getUTCHours()), pad(d.getUTCMinutes())];
};

/** "Fri": the UTC weekday. */
export const utcWeekday = (ms: number) => WEEKDAYS[new Date(ms).getUTCDay()]!;

/** "0100": the UTC hour and minute, schedule style. */
export function utcHhmm(ms: number): string {
  return hourMinute(ms).join("");
}

/** "8 Nov", or "8 Nov 2025" with the year: the UTC date. */
export function utcDate(ms: number, withYear = false): string {
  const d = new Date(ms);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withYear ? `${day} ${d.getUTCFullYear()}` : day;
}

/** "Fri 0100 UTC". */
export function utcLabel(ms: number): string {
  return `${utcWeekday(ms)} ${utcHhmm(ms)} UTC`;
}

/** The header clock's two lines: "Mon 23 Nov" over "14:05:09" (#106). */
export function utcClock(ms: number): { date: string; time: string } {
  return {
    date: `${utcWeekday(ms)} ${utcDate(ms)}`,
    time: `${utcClockShort(ms)}:${pad(new Date(ms).getUTCSeconds())}`,
  };
}

/** "14:05": the tuning bar's clock, minutes only. */
export function utcClockShort(ms: number): string {
  return hourMinute(ms).join(":");
}

/**
 * When a frequency was saved (#107): "saved Sat 2214 UTC"
 * within the last 6 UTC days, so the weekday can't be read as last week's;
 * "saved 8 Nov 2214 UTC" for older saves this UTC year; "saved 8 Nov 2025"
 * from another year. A save stamped a few minutes ahead of `nowMs` (the list's
 * minute tick, a clock corrected since) still reads as this week; further ahead
 * (a device clock running fast before the server's was measured) gets the
 * date, since a later weekday would read as one from last week.
 */
export function savedLabel(savedMs: number, nowMs: number): string {
  const daysAgo = Math.floor(nowMs / DAY_MS) - Math.floor(savedMs / DAY_MS);
  const ahead = savedMs - nowMs > AHEAD_SLACK_MS;
  if (!ahead && daysAgo <= 6) return `saved ${utcLabel(savedMs)}`;
  if (new Date(savedMs).getUTCFullYear() !== new Date(nowMs).getUTCFullYear()) {
    return `saved ${utcDate(savedMs, true)}`;
  }
  return `saved ${utcDate(savedMs)} ${utcHhmm(savedMs)} UTC`;
}

/** The stamp's hover detail (#107): "Saved Sat 21 Nov 2026, 2214 UTC · Sat 2:14 pm PST". */
export function savedTitle(savedMs: number, timeZone?: string): string {
  return `Saved ${utcWeekday(savedMs)} ${utcDate(savedMs, true)}, ${utcHhmm(savedMs)} UTC · ${localLabel(savedMs, timeZone)}`;
}

const LOCAL_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
};

/**
 * The device zone's formatter, made on first use and kept: building one per
 * call is slow, and a saved list can label 200 rows per render. Made lazily so
 * a test that sets the zone before its first call gets that zone. A zone
 * changed mid-visit (travel) keeps the old one until reload (accepted).
 */
let deviceFormat: Intl.DateTimeFormat | undefined;

/**
 * "Thu 5:00 pm PST": the weekday always (owner D16, the NA net's Friday UTC is
 * Thursday in the Americas) and the device's short zone name (D17). `timeZone`
 * is for tests; the page passes none, so it's the device's zone.
 */
export function localLabel(ms: number, timeZone?: string): string {
  const format =
    timeZone === undefined
      ? (deviceFormat ??= new Intl.DateTimeFormat("en-US", LOCAL_OPTIONS))
      : new Intl.DateTimeFormat("en-US", { ...LOCAL_OPTIONS, timeZone });
  const parts = format.formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()} ${get("timeZoneName")}`;
}
