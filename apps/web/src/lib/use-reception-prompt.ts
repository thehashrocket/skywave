"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { scheduledOn, type Broadcast } from "./eibi";
import { eibiTransmitter, type Transmitter } from "./reception";
import { DEFAULT_KIWI_PORT } from "./receiver";
import type { Mode } from "./radio-types";
import type { RadioStatus } from "./use-radio";

/**
 * How long audio must play, unchanged, on a frequency with a known station
 * before asking whether it was heard: long enough to have listened through a
 * station ID or a few minutes of programme, about what VE3SUN's dwell was
 * (issue #60).
 */
export const DWELL_MS = 60_000;

/** At most one prompt per this long in a tab, however often the listener retunes. */
export const PROMPT_GAP_MS = 10 * 60_000;

/** Closing the prompt this many times in a tab means "stop asking": no more prompts in it. */
export const MAX_DISMISSALS = 2;

/** How long "Thanks for the report." stays after an answer, in place of the prompt. */
export const THANKS_MS = 4_000;

// sessionStorage, so a reload in the same tab doesn't start the counts over.
const STORAGE_KEY = "skywave.receptionPrompt";

/** What a prompt asks about: the receiver and tuning it was offered on, and the transmitter. */
export type ReceptionPromptData = {
  host: string;
  port: number;
  freqKhz: number;
  mode: Mode;
  tx: Transmitter;
};

type Counts = { lastShownMs: number; dismissals: number };

function loadCounts(): Counts {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const c: unknown = raw ? JSON.parse(raw) : null;
    if (c && typeof c === "object" && "lastShownMs" in c && "dismissals" in c) {
      const { lastShownMs, dismissals } = c as Record<string, unknown>;
      if (typeof lastShownMs === "number" && typeof dismissals === "number") return { lastShownMs, dismissals };
    }
  } catch {
    /* storage unavailable or unreadable; start fresh */
  }
  return { lastShownMs: 0, dismissals: 0 };
}

function saveCounts(c: Counts) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* kept in memory for this page only */
  }
}

/** The receiver and tuning audio is playing on, or null while nothing is heard. */
function channelKey(status: RadioStatus, heardAudio: boolean): string | null {
  if (status.state !== "listening" || !heardAudio || !status.host || status.freqKhz === undefined || !status.mode)
    return null;
  return `${status.host.toLowerCase()}:${status.port ?? DEFAULT_KIWI_PORT}:${status.freqKhz}:${status.mode}`;
}

const promptKey = (p: ReceptionPromptData) => `${p.host.toLowerCase()}:${p.port}:${p.freqKhz}:${p.mode}`;

/**
 * "Did you hear it?": offers a reception prompt once audio has played for
 * DWELL_MS on one receiver, frequency and mode where the EiBi schedule lists
 * a station. A retune, mode change, another receiver, Stop or an error starts
 * the wait over. One prompt per channel until it changes, at most one per
 * PROMPT_GAP_MS in the tab (a later one waits for the gap), and none after
 * MAX_DISMISSALS closes.
 *
 * A prompt showing goes away on a retune or another receiver, since it no
 * longer names what's playing; after Stop or an error it stays, so a listener
 * who stopped can still answer.
 */
export function useReceptionPrompt(
  status: RadioStatus,
  heardAudio: boolean,
  schedule: readonly Broadcast[] | undefined,
) {
  const [prompt, setPrompt] = useState<ReceptionPromptData | null>(null);
  // Loaded from sessionStorage on first use, then kept here (storage may throw).
  const counts = useRef<Counts | null>(null);
  const update = useCallback((change: (c: Counts) => Counts) => {
    counts.current = change(counts.current ?? loadCounts());
    saveCounts(counts.current);
    return counts.current;
  }, []);

  // Read when the timer fires, so a new status object or a schedule refetch
  // for the same channel doesn't restart the wait.
  const latest = useRef({ status, schedule });
  latest.current = { status, schedule };
  // The channel a prompt was already offered on: not again until it changes.
  const askedOn = useRef<string | null>(null);

  const key = channelKey(status, heardAudio);
  const hasStation =
    key !== null && schedule !== undefined && scheduledOn(schedule, status.freqKhz!, Date.now()).length > 0;

  useEffect(() => {
    if (key !== null) setPrompt((p) => (p && promptKey(p) !== key ? null : p));
    if (askedOn.current !== key) askedOn.current = null;
    if (key === null || !hasStation || askedOn.current === key) return;
    const c = (counts.current ??= loadCounts());
    if (c.dismissals >= MAX_DISMISSALS) return;
    const wait = Math.max(DWELL_MS, c.lastShownMs + PROMPT_GAP_MS - Date.now());
    const timer = setTimeout(() => {
      const { status: s, schedule: sched } = latest.current;
      if (!sched || !s.host || s.freqKhz === undefined || !s.mode) return;
      // The listing may have ended during the wait.
      const tx = eibiTransmitter(scheduledOn(sched, s.freqKhz, Date.now()));
      if (!tx) return;
      askedOn.current = key;
      update((c) => ({ ...c, lastShownMs: Date.now() }));
      setPrompt({ host: s.host, port: s.port ?? DEFAULT_KIWI_PORT, freqKhz: s.freqKhz, mode: s.mode, tx });
    }, wait);
    return () => clearTimeout(timer);
  }, [key, hasStation, update]);

  /** The close button: counts toward MAX_DISMISSALS. */
  const dismiss = useCallback(() => {
    setPrompt(null);
    update((c) => ({ ...c, dismissals: c.dismissals + 1 }));
  }, [update]);

  /** Answered: goes away without counting as a dismissal, and thanks shows for THANKS_MS. */
  const [thanked, setThanked] = useState(false);
  const answered = useCallback(() => {
    setPrompt(null);
    setThanked(true);
  }, []);
  useEffect(() => {
    if (!thanked) return;
    const timer = setTimeout(() => setThanked(false), THANKS_MS);
    return () => clearTimeout(timer);
  }, [thanked]);

  return { prompt, thanked, dismiss, answered };
}
