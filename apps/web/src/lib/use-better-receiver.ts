"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { suggestBetter, type Suggestion } from "./better-receiver";
import { receiverKey, type Receiver } from "./kiwi-list";

/**
 * How long the dial must rest before an offer is worked out. Well above the
 * page's 120 ms retune coalescing, so a drag never shows one mid-move.
 */
export const REST_MS = 1_500;

type Where = { host: string; port: number };

const pair = (playing: Where, target: Where) => `${receiverKey(playing)}>${receiverKey(target)}`;

/**
 * "Switch to a better receiver?": once the dial rests, works out whether to
 * offer one (see suggestBetter). It only reports; switching is the page's
 * button. Any dial move hides the offer at once, so a button never moves under
 * a pointer that's still dragging.
 *
 * The anchor for "a real move" is the frequency when the receiver started
 * playing, or where the listener last said Not now. A dismissed target isn't
 * offered again from the same playing receiver this visit, even after a switch
 * that failed and came back.
 */
export function useBetterReceiver(a: {
  /** Off while nothing plays, a tune is under way, or Pick best is still running or watching. */
  enabled: boolean;
  receivers: readonly Receiver[] | undefined;
  playing: Where | null;
  freqKhz: number;
  isRefused: (r: Receiver) => boolean;
}) {
  const [offer, setOffer] = useState<Suggestion | null>(null);
  const playingKey = a.playing ? receiverKey(a.playing) : null;

  // Read when the timer fires, so a list refetch or a new object for the same
  // receiver doesn't restart the wait (and hide an offer that's showing).
  const playing = useRef(a.playing);
  playing.current = a.playing;
  const receivers = useRef(a.receivers);
  receivers.current = a.receivers;
  const isRefused = useRef(a.isRefused);
  isRefused.current = a.isRefused;
  const freq = useRef(a.freqKhz);
  freq.current = a.freqKhz;

  const anchor = useRef<{ key: string | null; khz: number }>({ key: null, khz: a.freqKhz });
  // "playing>target" pairs the listener said Not now to (or took).
  const dismissed = useRef(new Set<string>());

  /** Left out of offers, and of the switch an offer starts: refused just now, or declined from this receiver. */
  const excluded = useCallback((r: Receiver) => {
    const p = playing.current;
    return isRefused.current(r) || (p !== null && dismissed.current.has(pair(p, r)));
  }, []);

  useEffect(() => {
    if (anchor.current.key === playingKey) return;
    anchor.current = { key: playingKey, khz: freq.current };
  }, [playingKey]);

  const { enabled, freqKhz } = a;
  useEffect(() => {
    setOffer(null);
    const p = playing.current;
    if (!enabled || !p) return;
    const timer = setTimeout(() => {
      const list = receivers.current;
      if (!list) return;
      setOffer(
        suggestBetter({ receivers: list, playing: p, freqKhz, anchorKhz: anchor.current.khz, exclude: excluded }),
      );
    }, REST_MS);
    return () => clearTimeout(timer);
  }, [enabled, playingKey, freqKhz, excluded]);

  /** Not now: never this target again from this receiver, and measure the next move from here. */
  const dismiss = useCallback(() => {
    // Keyed by the status's host, as `excluded` reads it; the list may spell it in another case.
    const p = playing.current;
    if (offer && p) dismissed.current.add(pair(p, offer.target));
    anchor.current = { ...anchor.current, khz: freq.current };
    setOffer(null);
  }, [offer]);

  return { offer, dismiss, excluded };
}
