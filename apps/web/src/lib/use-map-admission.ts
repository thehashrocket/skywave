"use client";

import { useEffect, useState } from "react";

/** With nothing playing or connecting this long, the map may load anyway. */
export const IDLE_ADMIT_MS = 5_000;
/** Where requestIdleCallback is missing (Safari), wait this long instead. */
export const IDLE_FALLBACK_MS = 200;

type Radio = {
  /** The session has played audio. */
  heardAudio: boolean;
  /** A tune is starting, connecting, or listening without audio yet: the radio still needs the network. */
  busy: boolean;
};

/**
 * Whether the receiver map may load. The radio comes first: the map waits for
 * the session's first audio frame, or for 5 s with nothing playing or
 * connecting, then for an idle moment. Once admitted it stays admitted, so
 * switching receivers never unloads the map.
 */
export function useMapAdmission({ heardAudio, busy }: Radio): boolean {
  const [admitted, setAdmitted] = useState(false);
  const ready = heardAudio || !busy;

  useEffect(() => {
    if (admitted || !ready) return;
    let idle: number | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const admit = () => setAdmitted(true);
    const whenIdle = () => {
      // A busy page (meter, waterfall) may never look idle; don't wait past 2 s for it.
      if (typeof window.requestIdleCallback === "function")
        idle = window.requestIdleCallback(admit, { timeout: 2_000 });
      else fallback = setTimeout(admit, IDLE_FALLBACK_MS);
    };
    // Audio is playing: load at the next idle moment. Otherwise wait out the quiet period first.
    const wait = heardAudio ? undefined : setTimeout(whenIdle, IDLE_ADMIT_MS);
    if (heardAudio) whenIdle();
    // A tune starting cancels anything scheduled.
    return () => {
      clearTimeout(wait);
      clearTimeout(fallback);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  }, [admitted, ready, heardAudio]);

  return admitted;
}
