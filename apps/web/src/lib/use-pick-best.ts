"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { receiverKey, type Receiver } from "./kiwi-list";
import type { RadioErrorCode, RadioStatus } from "./use-radio";

/**
 * Each attempt takes a channel on, or at least knocks on, a volunteer's
 * receiver, so a run stops after this many such failures.
 */
export const MAX_ATTEMPTS = 3; // README "Using it" quotes this number.

/** How the skip note describes each failure. Every code needs one. */
const WHY_SKIPPED: Record<RadioErrorCode, string> = {
  busy: "was full",
  down: "is down",
  unreachable: "didn't answer",
  timeout: "didn't answer",
  password: "needs a password",
  redirect: "sent us elsewhere",
  bad_rate: "sent audio we can't play",
  closed: "hung up",
  invalid: "has a bad address",
  dns: "couldn't be found",
  blocked: "is on a private address",
};

/**
 * Refusals about the address itself (it doesn't resolve, is private, or is
 * malformed) take no channel on anyone's receiver, so they don't use up one
 * of the MAX_ATTEMPTS tries. A dead name can still take DNS_TIMEOUT_S
 * (hostguard.py) to give up on; a run stops after MAX_TOTAL receivers.
 */
const ADDRESS_CODES = new Set<RadioErrorCode>(["dns", "blocked", "invalid"]);
const MAX_TOTAL = 6; // README "Using it" quotes this number too.

/** Tunes a receiver; `fromList` says it came from the public list rather than being typed in. */
type Tune = (r: Receiver, fromList: boolean) => void;

type Chain = {
  candidates: Receiver[];
  tried: Receiver[];
  /** Failures that count against MAX_ATTEMPTS. */
  strikes: number;
  /** The status on screen when the run started, which says nothing about this run. */
  before: RadioStatus;
  /** What was playing when the run started, to go back to if nothing works. */
  fallback: { receiver: Receiver; fromList: boolean } | null;
  /** The current receiver was already tried again after a retryAfterMs hint. */
  retried: boolean;
  /** That retry, still waiting to fire. */
  retryTimer?: ReturnType<typeof setTimeout>;
};

/**
 * The receiver that was playing, from the list if it's there. `wasListed`
 * covers a list receiver the candidates no longer include (they only hold
 * receivers that cover the dial's current frequency).
 */
function playing(
  status: RadioStatus,
  candidates: Receiver[],
  wasListed: (host: string, port: number) => boolean,
): Chain["fallback"] {
  if (status.state !== "listening" || !status.host || !status.port) return null;
  const key = receiverKey({ host: status.host, port: status.port });
  const listed = candidates.find((r) => receiverKey(r) === key);
  if (listed) return { receiver: listed, fromList: true };
  const receiver: Receiver = {
    id: key,
    name: status.host,
    location: "",
    antenna: "",
    host: status.host,
    port: status.port,
    users: 0,
    usersMax: 0,
    snr: null,
    minKhz: 0,
    maxKhz: 0,
  };
  return { receiver, fromList: wasListed(status.host, status.port) };
}

/**
 * Tunes the best-ranked receiver and, if it turns out to be full or
 * unreachable, moves down the list. The list's user counts can be stale, so
 * the receiver's own "busy" answer is what we trust.
 */
export function usePickBest(
  status: RadioStatus,
  tune: Tune,
  /** Whether a candidate can still be tried, e.g. it covers the dial's current frequency. */
  accepts: (r: Receiver) => boolean = () => true,
  /** Whether the receiver now playing came from the public list. */
  wasListed: (host: string, port: number) => boolean = () => false,
) {
  const chain = useRef<Chain | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const latestStatus = useRef(status);
  latestStatus.current = status;
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;
  const wasListedRef = useRef(wasListed);
  wasListedRef.current = wasListed;

  /** End the chain, optionally leaving a note about why. */
  const finish = useCallback((why: string | null = null) => {
    clearTimeout(chain.current?.retryTimer);
    chain.current = null;
    setRunning(false);
    setNote(why);
  }, []);

  useEffect(() => () => clearTimeout(chain.current?.retryTimer), []);

  /** Switching away already dropped what was playing; go back to it if we can. */
  const goBack = useCallback(
    (c: Chain, why: string) => {
      const back = c.fallback;
      if (!back || c.tried.some((r) => receiverKey(r) === receiverKey(back.receiver))) return false;
      tune(back.receiver, back.fromList);
      finish(`${why} Back on ${back.receiver.name}.`);
      return true;
    },
    [finish, tune],
  );

  const start = useCallback(
    (candidates: Receiver[]) => {
      const first = candidates[0];
      if (!first) return finish("No listed receiver covers this frequency.");
      const before = latestStatus.current;
      chain.current = {
        candidates,
        tried: [first],
        strikes: 0,
        before,
        fallback: playing(before, candidates, wasListedRef.current),
        retried: false,
      };
      setRunning(true);
      setNote(null);
      tune(first, true);
    },
    [finish, tune],
  );

  /** The user chose something else (a row, Listen): just stop following. */
  const cancel = useCallback(() => finish(), [finish]);

  /**
   * The user pressed Stop picking: stop, and don't leave them in silence.
   * Returns false when there was nothing to go back to, so the caller can stop
   * the attempt still connecting.
   */
  const stop = useCallback((): boolean => {
    const c = chain.current;
    if (c && goBack(c, "Stopped.")) return true;
    finish();
    return false;
  }, [finish, goBack]);

  useEffect(() => {
    const c = chain.current;
    if (!c) return;
    // Clicking Pick best again right after a failure must not read that old
    // failure as the new attempt's answer.
    if (status === c.before) return;
    const current = c.tried[c.tried.length - 1]!;
    // A status naming another receiver belongs to an earlier attempt.
    if (status.host !== undefined && (status.host !== current.host || status.port !== current.port)) return;

    if (status.state === "listening") return finish();
    if (status.state !== "error") return;
    // Every coded error is about that receiver, so try the next one. Uncoded
    // ones are about the service (a bad request, its listener limit, a dropped
    // connection): it can't tune anything else right now either, so stop
    // without trying to go back. One of them, a lookup still stuck on an
    // earlier dead name, says when to try the same receiver again; do that once.
    if (!status.code) {
      if (!status.retryAfterMs || c.retried) return finish();
      c.retried = true;
      setNote(`Waiting on an earlier address lookup; trying ${current.name} again…`);
      c.retryTimer = setTimeout(() => {
        if (chain.current === c) tune(current, true);
      }, status.retryAfterMs);
      return;
    }
    if (!ADDRESS_CODES.has(status.code)) c.strikes++;
    const tried = new Set(c.tried.map(receiverKey));
    // The dial may have moved since the run started; skip what no longer fits.
    const next = c.candidates.find((r) => !tried.has(receiverKey(r)) && acceptsRef.current(r));
    if (!next || c.strikes >= MAX_ATTEMPTS || c.tried.length >= MAX_TOTAL) {
      const summary =
        c.tried.length === 1
          ? "Tried 1 receiver and it didn't work."
          : `Tried ${c.tried.length} receivers and none worked.`;
      if (goBack(c, summary)) return;
      return finish(`${summary} Pick one from the list.`);
    }
    c.tried.push(next);
    c.retried = false;
    setNote(`${current.name} ${WHY_SKIPPED[status.code]}; trying ${next.name}…`);
    tune(next, true);
  }, [status, tune, finish, goBack]);

  return { start, cancel, stop, note, running };
}
