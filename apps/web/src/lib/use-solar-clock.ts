"use client";

import { useEffect, useState } from "react";
import { sunPosition, type SunPosition } from "./solar";

const MINUTE = 60_000;

/** Where the sun is, and when that was (ms since epoch). */
export type SolarClock = SunPosition & { at: number };

/**
 * Where the sun is, updated on each minute boundary. One clock for the page,
 * so the table's Night column and the map's greyline always agree. Null until
 * mounted: the server's time isn't the viewer's.
 */
export function useSolarClock(): SolarClock | null {
  const [sun, setSun] = useState<SolarClock | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = Date.now();
      setSun({ ...sunPosition(now), at: now });
      timer = setTimeout(tick, MINUTE - (now % MINUTE));
    };
    tick();
    return () => clearTimeout(timer);
  }, []);

  return sun;
}
