import { track } from "@vercel/analytics";
import { useEffect, useRef } from "react";
import type { RadioRefusal, RadioStatus } from "./use-radio";

/**
 * Vercel Analytics custom events for the two things page views can't show:
 * did a visitor actually hear a receiver, and what stopped them when not.
 *
 * - listen_start: once per receiver connection, when its first audio plays
 *   (heardAudio), not when the socket opens: a Kiwi can accept and stay silent.
 *   A retune on the same receiver doesn't count again; a different receiver does.
 * - radio_error: each error status, with its code ("service" for our own,
 *   uncoded ones: a lost connection, a bad request, and the listener limit from a
 *   service older than skywave_full). Pick best hunting past full Kiwis sends
 *   several "busy"; unique visitors per code is the useful view. Skywave's own
 *   limits (skywave_cap, skywave_full) aren't a receiver or the service failing,
 *   so they never count here (#144, #146). Comparing "service" across the
 *   skywave_full deploy: before it, "service" included Skywave being full; after,
 *   pages that know the code send that as radio_refused skywave_full instead
 *   (tabs opened earlier keep the old way until they reload), so "service" falls
 *   for bookkeeping alone. Add radio_refused skywave_full back in to compare, or
 *   use the receiver log's skywave_full count (deploy/stats.sh).
 * - radio_refused: Skywave turned down a receiver for its own cap (skywave_cap),
 *   as an error status or as a refused switch with the old station playing on,
 *   or turned a listener away because it was full (skywave_full, #146).
 *   Once per listener action: `picking` (a Pick best run or its watch) leaves it
 *   to the run, which sends one at its end with how many receivers it met.
 */
export function useListenTracking(
  status: RadioStatus,
  heardAudio: boolean,
  refusal: RadioRefusal | null = null,
  picking = false,
): void {
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

  // `picking` is read when a status or refusal arrives, not as a trigger.
  const pickingRef = useRef(picking);
  pickingRef.current = picking;

  useEffect(() => {
    if (status.state !== "error") return;
    if (status.code !== "skywave_cap" && status.code !== "skywave_full")
      track("radio_error", { code: status.code ?? "service" });
    else if (!pickingRef.current) track("radio_refused", { code: status.code, receivers: 1, source: "listener" });
  }, [status]);

  const lastRefusal = useRef(0);
  useEffect(() => {
    if (!refusal || refusal.seq === lastRefusal.current) return;
    lastRefusal.current = refusal.seq;
    if (!pickingRef.current) track("radio_refused", { code: refusal.code, receivers: 1, source: "listener" });
  }, [refusal]);
}
