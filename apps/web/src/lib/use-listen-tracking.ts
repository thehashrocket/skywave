import { track } from "@vercel/analytics";
import { useEffect, useRef } from "react";
import type { RadioStatus } from "./use-radio";

/**
 * Vercel Analytics custom events for the two things page views can't show:
 * did a visitor actually hear a receiver, and what stopped them when not.
 *
 * - listen_start: once per receiver connection, when its first audio plays
 *   (heardAudio), not when the socket opens: a Kiwi can accept and stay silent.
 *   A retune on the same receiver doesn't count again; a different receiver does.
 * - radio_error: each error status, with its code ("service" for our own,
 *   uncoded ones: the listener limit, a lost connection). Pick best hunting past
 *   full Kiwis sends several "busy"; unique visitors per code is the useful view.
 */
export function useListenTracking(status: RadioStatus, heardAudio: boolean): void {
  const countedRef = useRef<string | null>(null);

  useEffect(() => {
    if (status.state !== "listening" && status.state !== "connecting") countedRef.current = null;
    if (!heardAudio || status.state !== "listening" || !status.host) return;
    const key = `${status.host.toLowerCase()}:${status.port ?? ""}`;
    if (countedRef.current === key) return;
    countedRef.current = key;
    track("listen_start", {
      mode: status.mode ?? null,
      mhz: status.freqKhz !== undefined ? Math.floor(status.freqKhz / 1000) : null,
    });
  }, [status, heardAudio]);

  useEffect(() => {
    if (status.state === "error") track("radio_error", { code: status.code ?? "service" });
  }, [status]);
}
