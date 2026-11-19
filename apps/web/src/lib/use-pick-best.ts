"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LIST_MAX_AGE_MS, receiverKey, type Receiver } from "./kiwi-list";
import { pickContext, pickKey, type PickContext, type PickSource } from "./pick-context";
import { DEFAULT_KIWI_PORT } from "./receiver";
import { onServerOffset, serverClockCorrections, serverNow } from "./server-clock";
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

/**
 * A receiver that refused is left out of new runs for this long, the age the
 * public list's copy can reach: its stale counts would rank it first again, and
 * retrying cuts the listener off and knocks on the volunteer's receiver for
 * nothing. Playing again clears it.
 */
export const REFUSED_MS = LIST_MAX_AGE_MS; // README "Using it" quotes this number too.

/**
 * Only the receiver's own answers count as a refusal. Drops and timeouts can be
 * one network blip, address and setup errors aren't about the volunteer's
 * receiver, and "down"/"unreachable" can be the radio service's own network
 * (its ScanCache doesn't remember drops or timeouts either).
 */
const REFUSALS = new Set<RadioErrorCode>(["busy", "no_apps", "password"]);

const refusedKey = (r: { host: string; port?: number }) =>
  receiverKey({ host: r.host.toLowerCase(), port: r.port ?? DEFAULT_KIWI_PORT });

const MAX_TOTAL = 6; // README "Using it" quotes this number too.

/**
 * Some receivers refuse only after playing for a while: one whose owner allows
 * no apps (ext_api=0) refuses about 10 s in, and some say they're full about as
 * late. The list hides the first kind, but an owner can change the setting after
 * the list was fetched, so a run keeps an eye on the receiver it settled on for
 * this long after it starts playing, and moves on if it refuses.
 */
export const WATCH_MS = 15_000; // README "Using it" quotes this number too.

/** Tunes a receiver; `fromList` says it came from the public list rather than being typed in. */
type Tune = (r: Receiver, fromList: boolean) => void;

/** How the receiver at host:port is being dialed: from the list or typed, and over wss:// or not. */
export type Provenance = (host: string, port: number) => { fromList: boolean; secure: boolean };

type Fallback = { receiver: Receiver; fromList: boolean };

/** What a run was asked to do, kept for the report context (pick-context). */
export type PickRun = { source: PickSource; freqKhz: number };

type Chain = {
  /** The ranked list as given, refused receivers included: rankPos counts in this. */
  ranked: Receiver[];
  run?: PickRun;
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
function playing(status: RadioStatus, candidates: readonly Receiver[], provenance: Provenance): Fallback | null {
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
  // No run and no watch: whatever is playing stays. `running` goes false as
  // soon as a receiver plays, while the watch below can still move on.
  const [settled, setSettled] = useState(true);
  const latestStatus = useRef(status);
  latestStatus.current = status;
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;
  const provenanceRef = useRef(provenance);
  provenanceRef.current = provenance;
  // When each receiver last refused, by refusedKey.
  const refused = useRef(new Map<string, number>());
  /**
   * How a run chose the receiver it last tuned. Outlives the chain (the
   * reception prompt comes a minute or more after the watch ends); a new run,
   * a hand pick (cancel) or the way back to the old receiver replaces or drops it.
   */
  const picked = useRef<{ key: string; context: PickContext; corrections: number } | null>(null);
  /**
   * How many times a choice has been dropped. A question that snapshotted a
   * choice compares this when answered: any drop in between (a hand pick, a
   * dial move, a failed or abandoned run, or a run moving to another receiver)
   * revokes the snapshot, even if a later run or the same chain then picks the
   * same receiver again on the same frequency.
   */
  const drops = useRef(0);
  const drop = useCallback(() => {
    if (picked.current) drops.current++;
    picked.current = null;
  }, []);
  // A choice's time is the page's server clock when it was made. If the clock
  // is corrected after (a measurement found it off, or a jump was undone), that
  // time may be off by as much, and a question's slot is on the corrected
  // clock: drop the choice. A sleep the measurement confirms corrects nothing.
  useEffect(
    () =>
      onServerOffset(() => {
        if (picked.current && picked.current.corrections !== serverClockCorrections()) drop();
      }),
    [drop],
  );
  /** Tunes a candidate of `c` and notes how it was chosen. */
  const tuneCandidate = useCallback(
    (c: Chain, r: Receiver) => {
      if (!c.run) drop();
      else {
        const key = pickKey(r);
        // Moving to another receiver leaves the one a question asked about, so
        // it counts as a drop; the same receiver again just replaces it.
        if (picked.current && picked.current.key !== key) drops.current++;
        const context = pickContext(c.ranked, r, c.run.source, c.run.freqKhz, serverNow());
        picked.current = { key, context, corrections: serverClockCorrections() };
      }
      tune(r, true);
    },
    [tune, drop],
  );
  /**
   * Forgets how the last run chose once the dial is somewhere it didn't rank
   * for: coming back to that frequency later is the listener's own choice, and
   * its pick time would be long before the listening an answer is about.
   */
  const forgetOffFrequency = useCallback((freqKhz: number) => {
    if (picked.current && picked.current.context.freqKhz !== freqKhz) drop();
  }, [drop]);
  /** How a run chose the receiver at host:port, or null if no run chose it (a hand pick, the way back). */
  const pickedFor = useCallback((host: string, port: number): PickContext | null => {
    const p = picked.current;
    // A correction whose notice hasn't run yet still leaves the time wrong.
    if (!p || p.corrections !== serverClockCorrections()) return null;
    return p.key === pickKey({ host, port }) ? p.context : null;
  }, []);
  /** Whether this receiver refused within REFUSED_MS, so neither a run nor a suggestion should offer it. */
  const isRefused = useCallback(
    (r: { host: string; port?: number }) => Date.now() - (refused.current.get(refusedKey(r)) ?? -Infinity) < REFUSED_MS,
    [],
  );

  /** End the chain, optionally leaving a note about why. */
  const finish = useCallback((why: string | null = null) => {
    clearTimers(chain.current);
    chain.current = null;
    setRunning(false);
    setSettled(true);
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
      // The receiver it goes back to wasn't chosen by this run (and maybe not by any).
      drop();
      setRunning(false);
      setNote(`${why} Going back to ${back.receiver.name}…`);
      tune(back.receiver, back.fromList);
      return true;
    },
    [tune, drop],
  );

  /**
   * Starts a run; false when none began (nothing covers, or everything refused).
   * `known` lends the receiver playing now its listed name for the way back,
   * when the candidates leave it out.
   */
  const start = useCallback(
    (covering: Receiver[], known: readonly Receiver[] = covering, run?: PickRun): boolean => {
      // A beacon Listen that tunes nothing still ends the last run's claim: the
      // old receiver keeps playing on a band where another beacon is now asked
      // about. Any other run that can't start leaves the playing receiver's
      // choice standing; a dial move drops it anyway (forgetOffFrequency), and
      // a run that does start replaces it.
      if (run?.source === "beacon") drop();
      if (!covering.length) {
        finish("No listed receiver covers this frequency.");
        return false;
      }
      const candidates = covering.filter((r) => !isRefused(r));
      const first = candidates[0];
      if (!first) {
        finish(
          covering.length === 1
            ? `${covering[0]!.name} is the only listed receiver for this frequency, and it just refused. Try again in ${REFUSED_MS / 60_000} minutes, or pick another frequency.`
            : `Every listed receiver for this frequency refused in the last ${REFUSED_MS / 60_000} minutes. Try again later, or pick another frequency.`,
        );
        return false;
      }
      clearTimers(chain.current);
      const before = latestStatus.current;
      const c: Chain = {
        ranked: covering,
        run,
        candidates,
        tried: [first],
        strikes: 0,
        before,
        fallback: playing(before, known, provenanceRef.current),
        retried: false,
      };
      chain.current = c;
      setRunning(true);
      setSettled(false);
      setNote(null);
      tuneCandidate(c, first);
      return true;
    },
    [finish, tuneCandidate, isRefused, drop],
  );

  /** The user chose something else (a row, Listen): just stop following, and forget how the last run chose. */
  const cancel = useCallback(() => {
    drop();
    finish();
  }, [finish, drop]);

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
    // Abandoned mid-run: a tune still in flight mustn't count as its choice.
    if (c) drop();
    finish();
    return false;
  }, [finish, goBack, drop]);

  useEffect(() => {
    // A coded refusal is the receiver's own answer, however it was dialed; a
    // receiver that plays has answered the other way.
    if (status.state === "error" && status.code && REFUSALS.has(status.code) && status.host)
      refused.current.set(refusedKey({ host: status.host, port: status.port }), Date.now());
    else if (status.state === "listening" && status.host)
      refused.current.delete(refusedKey({ host: status.host, port: status.port }));
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
      // Dial and mode retunes of that receiver keep the watch; its own refusal
      // (full, no apps, password) picks the run up again, moving on as for any
      // refusal. Anything else (a drop, another error, the radio stopping)
      // ends the watch.
      const about = status.host === current.host && status.port === current.port;
      if (about && (status.state === "listening" || status.state === "connecting")) return;
      if (!about || status.state !== "error" || !status.code || !REFUSALS.has(status.code)) return finish();
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
        if (chain.current !== c) return;
        chain.current = null;
        setSettled(true);
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
      if (!status.retryAfterMs || c.retried) {
        // The run ends on the service's failure, not on a choice that played.
        drop();
        return finish();
      }
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
      // Out of receivers and nowhere to go back to: the last one tried refused, so nothing was chosen.
      drop();
      return finish(`${summary} Pick one from the list.`);
    }
    c.tried.push(next);
    c.retried = false;
    setNote(`${current.name} ${WHY_SKIPPED[status.code]}; trying ${next.name}…`);
    tuneCandidate(c, next);
  }, [status, tune, tuneCandidate, finish, goBack, drop]);

  /** How many choices have been dropped so far (see `drops`). */
  const dropCount = useCallback(() => drops.current, []);

  return { start, cancel, stop, note, running, settled, isRefused, pickedFor, forgetOffFrequency, forget: drop, dropCount };
}
