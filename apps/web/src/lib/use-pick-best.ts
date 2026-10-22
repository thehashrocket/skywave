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
  no_apps: "only takes listeners on its own web page",
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

/**
 * A receiver whose owner allows no apps (ext_api=0) plays for about 10 s
 * before it refuses. The list hides those, but an owner can change the
 * setting after the list was fetched, so a run keeps an eye on the receiver
 * it settled on for this long after it starts playing.
 */
export const WATCH_MS = 15_000; // README "Using it" quotes this number too.

/** Tunes a receiver; `fromList` says it came from the public list rather than being typed in. */
type Tune = (r: Receiver, fromList: boolean) => void;

/** How the receiver at host:port is being dialed: from the list or typed, and over wss:// or not. */
export type Provenance = (host: string, port: number) => { fromList: boolean; secure: boolean };

type Fallback = { receiver: Receiver; fromList: boolean };

type Chain = {
  candidates: Receiver[];
  tried: Receiver[];
  /** Failures that count against MAX_ATTEMPTS. */
  strikes: number;
  /** The status on screen when the run started, which says nothing about this run. */
  before: RadioStatus;
  /** What was playing (or connecting) when the run started, to go back to if nothing works. */
  fallback: Fallback | null;
  /**
   * Set once the run has given up and is tuning `fallback` again. The chain
   * stays to watch that reconnect, so the note only says "Back on" once it's true.
   */
  returning?: { receiver: Receiver; why: string };
  /** The current receiver was already tried again after a retryAfterMs hint. */
  retried: boolean;
  /** That retry, still waiting to fire. */
  retryTimer?: ReturnType<typeof setTimeout>;
  /**
   * The run looks finished (the receiver plays), but for WATCH_MS a refusal
   * from that receiver picks it up again. Ends when this timer fires.
   */
  watchTimer?: ReturnType<typeof setTimeout>;
};

function clearTimers(c: Chain | null) {
  clearTimeout(c?.retryTimer);
  clearTimeout(c?.watchTimer);
}

/**
 * The receiver playing or connecting when the run started. How it was dialed
 * comes from the page, never from the candidates: a receiver you typed that
 * also happens to be listed must come back as typed. The matching candidate,
 * if any, only lends its name.
 */
function playing(status: RadioStatus, candidates: Receiver[], provenance: Provenance): Fallback | null {
  if ((status.state !== "listening" && status.state !== "connecting") || !status.host || !status.port) return null;
  const key = receiverKey({ host: status.host, port: status.port });
  const details = candidates.find((r) => receiverKey(r) === key) ?? {
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
  const { fromList, secure } = provenance(status.host, status.port);
  // The row's own `secure` says how it's listed, not how it was dialed.
  return { receiver: { ...details, secure: secure || undefined }, fromList };
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
  /** How the receiver now playing was dialed. */
  provenance: Provenance = () => ({ fromList: false, secure: false }),
) {
  const chain = useRef<Chain | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const latestStatus = useRef(status);
  latestStatus.current = status;
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;
  const provenanceRef = useRef(provenance);
  provenanceRef.current = provenance;

  /** End the chain, optionally leaving a note about why. */
  const finish = useCallback((why: string | null = null) => {
    clearTimers(chain.current);
    chain.current = null;
    setRunning(false);
    setNote(why);
  }, []);

  useEffect(() => () => clearTimers(chain.current), []);

  /**
   * Switching away already dropped what was playing; go back to it if we can.
   * The run is over (the button reads Pick best again), but the chain stays
   * until the reconnect succeeds or fails, so the note is true either way.
   */
  const goBack = useCallback(
    (c: Chain, why: string) => {
      const back = c.fallback;
      if (!back || c.tried.some((r) => receiverKey(r) === receiverKey(back.receiver))) return false;
      clearTimeout(c.retryTimer);
      c.returning = { receiver: back.receiver, why };
      setRunning(false);
      setNote(`${why} Going back to ${back.receiver.name}…`);
      tune(back.receiver, back.fromList);
      return true;
    },
    [tune],
  );

  const start = useCallback(
    (candidates: Receiver[]) => {
      const first = candidates[0];
      if (!first) return finish("No listed receiver covers this frequency.");
      clearTimers(chain.current);
      const before = latestStatus.current;
      chain.current = {
        candidates,
        tried: [first],
        strikes: 0,
        before,
        fallback: playing(before, candidates, provenanceRef.current),
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
   * the attempt still connecting; true when nothing more is needed.
   */
  const stop = useCallback((): boolean => {
    const c = chain.current;
    // While only watching, the receiver the run settled on is playing: end the
    // watch and leave it playing.
    if (c?.watchTimer) {
      finish();
      return true;
    }
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
    if (c.returning) {
      const { receiver: back, why } = c.returning;
      if (status.host !== undefined && (status.host !== back.host || status.port !== back.port)) return;
      if (status.state === "listening") return finish(`${why} Back on ${back.name}.`);
      if (status.state === "error") return finish(`${why} Couldn't get back to ${back.name}.`);
      return;
    }
    const current = c.tried[c.tried.length - 1]!;
    if (c.watchTimer) {
      // Dial and mode retunes of that receiver keep the watch; its refusal of
      // apps picks the run up again, moving on as for any refusal. Anything
      // else (another error, the radio stopping) ends the watch.
      const about = status.host === current.host && status.port === current.port;
      if (about && (status.state === "listening" || status.state === "connecting")) return;
      if (!about || status.state !== "error" || status.code !== "no_apps") return finish();
      clearTimeout(c.watchTimer);
      c.watchTimer = undefined;
      setRunning(true);
    }
    // A status naming another receiver belongs to an earlier attempt.
    if (status.host !== undefined && (status.host !== current.host || status.port !== current.port)) return;

    if (status.state === "listening") {
      // Done, as far as anyone can see; keep watching for a late refusal.
      clearTimeout(c.retryTimer);
      setRunning(false);
      setNote(null);
      c.watchTimer = setTimeout(() => {
        if (chain.current === c) chain.current = null;
      }, WATCH_MS);
      return;
    }
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
