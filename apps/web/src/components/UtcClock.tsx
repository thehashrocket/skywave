"use client";

import { useServerTick } from "@/lib/use-server-tick";
import { utcClock, utcClockShort } from "@/lib/utc-time";

/** Stand-ins for a real reading: the tabular time line sizes the clock, so the hidden placeholder takes its exact width. */
const SIZE_OF = { date: "Wed 28 Sep", time: "00:00:00", short: "00:00" };

/**
 * The live UTC clock (#106). Reads the server-corrected time (server-clock.ts)
 * through useServerTick, so it agrees with the beacon slots and GhostNet
 * countdowns on a device whose clock is off; until the first measurement it
 * shows the device's time and then corrects once, with no "syncing" sign.
 *
 * The header's form is the UTC weekday and date over HH:MM:SS; `compact` is
 * the tuning bar's, HH:MM only, updated once a minute.
 *
 * Not a live region: a screen reader reading the header hears the time once,
 * and is never interrupted each second. Before mount (the server's render
 * can't know the viewer's time) it renders the same lines with stand-in text,
 * hidden, so the header doesn't move when the time arrives.
 */
export function UtcClock({ compact = false }: { compact?: boolean }) {
  const now = useServerTick(compact ? 60_000 : 1_000);
  const pending = now === null;
  const reading = pending ? SIZE_OF : { ...utcClock(now), short: utcClockShort(now) };
  const date = compact ? null : reading.date;
  const digits = compact ? reading.short : reading.time;

  return (
    <time
      className="utc-clock"
      dateTime={pending ? undefined : new Date(now).toISOString()}
      data-pending={pending || undefined}
    >
      {date !== null && (
        <>
          <span className="utc-clock-date">{date}</span>{" "}
        </>
      )}
      <span className="utc-clock-time">
        <span className="utc-clock-digits">{digits}</span> <span className="utc-clock-unit">UTC</span>
      </span>
    </time>
  );
}
