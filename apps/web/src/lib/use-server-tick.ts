"use client";

import { useEffect, useState } from "react";
import { onServerOffset, serverNow } from "./server-clock";

/**
 * A little past each boundary, so a timer that fires a hair early doesn't
 * land back in the step that just ended.
 */
const PAST_BOUNDARY_MS = 20;

/**
 * The server's time, rounded down to `stepMs` and updated on each boundary:
 * SLOT_MS for what's on the air, 1 s for a countdown. Starts over when the
 * server's offset becomes known, so a skewed clock is corrected at once. Null
 * while `enabled` is false, and until mounted (the server's render has no
 * viewer's clock).
 */
export function useServerTick(stepMs: number, enabled = true): number | null {
  const [tick, setTick] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setTick(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const run = () => {
      clearTimeout(timer);
      const now = serverNow();
      const start = now - (((now % stepMs) + stepMs) % stepMs);
      setTick(start);
      timer = setTimeout(run, start + stepMs - now + PAST_BOUNDARY_MS);
    };
    run();
    const unsubscribe = onServerOffset(run);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [stepMs, enabled]);

  return tick;
}
