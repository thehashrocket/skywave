"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { rankReceivers, type Receiver } from "./kiwi-list";
import { NOISE_MAX_RECEIVERS, noiseKey } from "./noise-rank";

const SERVICE_URL = process.env.NEXT_PUBLIC_RADIO_WS_URL ?? "ws://localhost:8765/ws";

/**
 * How often the page asks again while it's visible. Listeners come and go in
 * minutes; an answer this old only reorders Pick best, and a receiver that
 * filled since still answers with its own refusal (skywave_cap), as before.
 */
export const HELD_REFRESH_MS = 60_000;

/**
 * After this page's receiver changes or stops, how long until it asks once
 * more. The service frees the old slot only once that session has closed its
 * Kiwi, so the answer to the ask made at once usually still counts it. Closing
 * takes up to two 2 s timeouts (CLOSE_TIMEOUT_S in kiwi.py), so by this ask
 * the slot is normally free and the receiver just left stops reading as taken.
 */
export const HELD_SETTLE_MS = 5_000;

const NOTHING: ReadonlySet<string> = new Set();

/** GET /held on the radio service the WebSocket URL points at, or null if that URL doesn't parse. */
export function heldUrl(wsUrl: string, keys: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return null;
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.replace(/\/ws\/?$/, "") + "/held";
  url.search = new URLSearchParams({ receivers: keys.join(",") }).toString();
  return url.toString();
}

/** The service's answer as a set of noiseKeys, or null if it isn't one. */
export function parseHeld(body: unknown): ReadonlySet<string> | null {
  if (typeof body !== "object" || body === null) return null;
  const { held } = body as Record<string, unknown>;
  if (!Array.isArray(held)) return null;
  return new Set(held.filter((k): k is string => typeof k === "string"));
}

/**
 * The receivers near the top of the list for this frequency that already have
 * as many Skywave listeners as the radio service allows on one receiver
 * (skywave_cap, #155), by noiseKey. Pick best tries them last and the list
 * marks them. Empty until the service answers, and as soon as it can't (down,
 * older than /held, or a route not yet deployed): everything is then tried in
 * rank order, as before, rather than steered by an answer that may be stale.
 *
 * The receivers asked about are the top NOISE_MAX_RECEIVERS that Pick best
 * ranks at the dial itself, so its candidates are the ones checked. The sorted
 * key list only changes (and asks again) when the dial crosses a receiver's
 * coverage edge. `playing` is this page's receiver (noiseKey, or null): when it
 * changes, the page asks again at once and once more HELD_SETTLE_MS later, so
 * one it just left stops reading as taken.
 */
export function useHeld(
  receivers: readonly Receiver[] | undefined,
  freqKhz: number,
  playing: string | null = null,
): ReadonlySet<string> {
  const keys = useMemo(
    () =>
      receivers ? rankReceivers(receivers, freqKhz).slice(0, NOISE_MAX_RECEIVERS).map(noiseKey).sort().join(",") : "",
    [receivers, freqKhz],
  );
  const [held, setHeld] = useState<{ keys: string; set: ReadonlySet<string> }>({ keys: "", set: NOTHING });
  // The receiver the last ask was made for, to tell a change of it from a change of keys.
  const askedFor = useRef(playing);
  // When the ask owed for that change is due (0: none owed). Kept across runs, so a
  // dial move in the meantime moves it to the new keys instead of dropping it.
  const settleAt = useRef(0);
  useEffect(() => {
    if (askedFor.current !== playing) settleAt.current = Date.now() + HELD_SETTLE_MS;
    askedFor.current = playing;
    if (!keys) return;
    const url = heldUrl(SERVICE_URL, keys.split(","));
    if (!url) return;
    let abort: AbortController | null = null;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      abort?.abort();
      const mine = (abort = new AbortController());
      fetch(url, { signal: mine.signal, cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (mine.signal.aborted) return;
          // A refusal or a malformed answer is no answer: forget the last one.
          setHeld({ keys, set: parseHeld(body) ?? NOTHING });
        })
        .catch(() => {
          // Down, older (no /held), or blocked: forget the last answer. An abort is ours.
          if (!mine.signal.aborted) setHeld({ keys, set: NOTHING });
        });
    };
    load();
    const owed = settleAt.current - Date.now();
    const settle =
      settleAt.current > 0
        ? setTimeout(
            () => {
              settleAt.current = 0;
              load();
            },
            Math.max(0, owed),
          )
        : undefined;
    const timer = setInterval(load, HELD_REFRESH_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      clearTimeout(settle);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
      abort?.abort();
    };
    // `playing` only says when to ask again; the answer doesn't depend on it.
  }, [keys, playing]);
  // An answer about other receivers says nothing about these.
  return held.keys === keys ? held.set : NOTHING;
}
