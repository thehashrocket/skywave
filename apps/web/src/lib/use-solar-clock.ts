"use client";

import { useEffect, useState } from "react";
import { onServerOffset, serverNow } from "./server-clock";
import { sunPosition, type SunPosition } from "./solar";

const MINUTE = 60_000;

/** Where the sun is, and when that was (ms since epoch, server-corrected). */
export type SolarClock = SunPosition & { at: number };

/**
 * Where the sun is, and the minute the page goes by, updated on each minute
 * boundary of the server-corrected clock (#148 D14): the page's one clock for
 * everything that decides "on now" (station names, Find a station, the
 * greyline), so names flip at a slot's start, as the Signal stations panel
 * does, even on a device whose own clock is off. Re-read at once when the
 * clock's correction is first measured or changes. Null until mounted: the
 * server-rendered page has no viewer's time.
 */
export function useSolarClock(): SolarClock | null {
  const [sun, setSun] = useState<SolarClock | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      clearTimeout(timer);
      const now = serverNow();
      setSun({ ...sunPosition(now), at: now });
      timer = setTimeout(tick, MINUTE - (now % MINUTE));
    };
    tick();
    const off = onServerOffset(tick);
    return () => {
      clearTimeout(timer);
      off();
    };
  }, []);

  return sun;
}
