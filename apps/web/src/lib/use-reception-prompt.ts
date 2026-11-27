"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listedOn, rankBroadcasts, scheduledOn, type Broadcast } from "./eibi";
import type { BroadRegion } from "./eibi-targets";
import { ibpBandIndex } from "./ibp";
import {
  beaconPromptAt,
  beaconTransmitter,
  eibiTransmitter,
  LISTING_GRACE_MS,
  SAME_CHANNEL_MS,
  signalGroupTransmitter,
  signalPromptAt,
  signalTransmitter,
  TX_NAME_SEPARATOR,
  type BeaconPick,
  type SignalAsk,
  type Transmitter,
} from "./reception";
import { DEFAULT_KIWI_PORT } from "./receiver";
import type { Mode } from "./radio-types";
import { onServerOffset, serverNow } from "./server-clock";
import { onKhz } from "./signal-panel";
import type { RadioStatus } from "./use-radio";

/**
 * How long audio must play, unchanged, on a frequency with a known station
 * before asking whether it was heard: long enough to have listened through a
 * station ID or a few minutes of programme, about what VE3SUN's dwell was
 * (issue #60).
 */
export const DWELL_MS = 60_000;

/**
 * Past SAME_CHANNEL_MS before asking about a beacon or signal station this tab
 * already answered about on the same receiver and frequency: the server counts a report made
 * exactly that long ago, by its own clock and the answer's arrival, so ask a
 * little after.
 */
export const SAME_CHANNEL_SLACK_MS = 60_000;

/** At most one prompt per this long in a tab, however often the listener retunes. */
export const PROMPT_GAP_MS = 10 * 60_000;

/** Closing the prompt this many times in a tab means "stop asking": no more prompts in it. */
export const MAX_DISMISSALS = 2;

/** How long "Thanks for the report." stays after an answer, in place of the prompt. */
export const THANKS_MS = 4_000;

/**
 * An unanswered prompt goes away after this long (not counted as a close).
 * The server only takes an answer about a listing on air in the last
 * LISTING_GRACE_MS; a minute less leaves room for the schedule's whole
 * minutes and a little clock difference, so the prompt never asks a
 * question whose answer would be dropped.
 */
export const PROMPT_TTL_MS = LISTING_GRACE_MS - 60_000;

/**
 * How much earlier than the server's last chance a late beacon question gives
 * up: the page's clock error (about a second) and the answer's trip.
 */
export const LATE_ANSWER_SLACK_MS = 5_000;

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

/**
 * `beacons`: when this tab last sent an answer about each beacon or signal
 * station (#101) on each receiver and frequency (answerKey), by this
 * browser's clock. The server takes one per SAME_CHANNEL_MS; the prompt waits
 * that out. (Named for beacons, the first kind kept; callsigns are upper case
 * and station slugs lower case, so the two never share a key.)
 */
type Counts = { lastShownMs: number; dismissals: number; beacons?: Record<string, number> };

function loadCounts(): Counts {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const c: unknown = raw ? JSON.parse(raw) : null;
    if (c && typeof c === "object" && "lastShownMs" in c && "dismissals" in c) {
      const { lastShownMs, dismissals, beacons } = c as Record<string, unknown>;
      if (typeof lastShownMs === "number" && typeof dismissals === "number") {
        // Only entries we wrote: string keys to numbers.
        const sent =
          beacons && typeof beacons === "object"
            ? Object.fromEntries(Object.entries(beacons).filter(([, ms]) => typeof ms === "number"))
            : {};
        return { lastShownMs, dismissals, beacons: sent as Record<string, number> };
      }
    }
  } catch {
    /* storage unavailable or unreadable; start fresh */
  }
  return { lastShownMs: 0, dismissals: 0 };
}

/** One beacon (by callsign) or signal station (by slug) on one receiver and frequency, as the server's same-channel limit counts it. */
function answerKey(host: string, port: number, freqKhz: number, name: string): string {
  return `${host.toLowerCase()}:${port}:${freqKhz}:${name}`;
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
 * DWELL_MS on one receiver, frequency and mode where a station is on the air,
 * on a receiver from the public list (`onList`: the server only
 * keeps reports about listed receivers, so a typed one is never asked about).
 * A retune, mode change, another receiver, Stop or an error starts the wait
 * over. One prompt per channel until it changes, at most one per
 * PROMPT_GAP_MS in the tab (a later one waits for the gap), and none after
 * MAX_DISMISSALS closes.
 *
 * A prompt showing goes away on a retune or another receiver, since it no
 * longer names what's playing, and after PROMPT_TTL_MS unanswered; after Stop
 * or an error it stays until then, so a listener who stopped can still answer.
 *
 * On an IBP beacon frequency a new beacon takes over every 10 s, so a minute
 * there spans six. There it asks only about `beacon`, the one picked with
 * Listen, on the band it was picked on, once enough of its slot has played
 * (beaconPromptAt). Tuned to a beacon frequency by hand: no prompt at all.
 *
 * `signal`: the signal station the question is about (#101, #148): the one
 * picked with Listen, while the dial is on a channel it's on the air on
 * (signalAsk), or, tuned by hand, the one catalog station on the dial when
 * it's the only station there and not a season row standing in for Priyom's
 * (owner D3, D12, D5; the page works it out). Then it's the only thing asked
 * about, once DWELL_MS has played after first audio plus STREAM_LATENCY_MS,
 * all of it before the station goes off (signalPromptAt); one that goes off
 * first isn't asked about. A list of stations: tuned by hand to a frequency two
 * or more catalog stations share (WWV and WWVH, #150; signalGroupAsk), one
 * question asks which of them was heard, under the same dwell and limits, open
 * until the first of them goes off.
 *
 * `schedule`: what an EiBi question may name: EiBi's rows less the Priyom
 * stations' (the server refuses those, D9), so on a frequency several stations
 * share, with fewer than two catalog stations among them, the question is
 * today's (D12; with two or more, #150's group question), and a season row standing in for
 * Priyom's is never asked about (D5). Read on the server-corrected clock (D14).
 *
 * `region` is where the receiver is, from its listed position only (never a
 * filter the listener picked, since answers are saved under the station named):
 * stations sharing the frequency that are aimed there are asked about first
 * (#115). While a receiver plays the readout ranks by the same region, but it
 * also puts catalog and Priyom stations first on a tie (#152) and this, reading
 * EiBi's own rows, doesn't: on 10 MHz the readout names WWV while this asks
 * about PPE. Undefined keeps EiBi's order.
 */
export function useReceptionPrompt(
  status: RadioStatus,
  heardAudio: boolean,
  schedule: readonly Broadcast[] | undefined,
  onList: boolean,
  beacon: BeaconPick | null = null,
  region?: BroadRegion,
  signal: SignalAsk | readonly SignalAsk[] | null = null,
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
  const latest = useRef({ status, schedule, region, signal });
  latest.current = { status, schedule, region, signal };
  // The channel a prompt was already offered on: not again until it changes.
  const askedOn = useRef<string | null>(null);

  const key = channelKey(status, heardAudio);
  const band = key === null ? -1 : ibpBandIndex(status.freqKhz!);
  // The Listen pick, while the dial is on the band it was picked on.
  const pick = beacon && band >= 0 && beacon.bandIndex === band ? beacon : null;
  // The signal station(s) asked about, while the dial is on the channel they were offered for.
  const asks: readonly SignalAsk[] = signal === null ? [] : "slug" in signal ? [signal] : signal;
  const sig = key !== null && asks.length > 0 && asks.every((a) => onKhz(status.freqKhz!, a.khz)) ? asks : null;
  // Changes only when what would be asked about does, not with a new object.
  const sigKey = sig && sig.map((a) => `${a.slug}|${a.khz}|${a.untilMs}|${a.slotStartMs ?? ""}`).join(",");
  const askable =
    key !== null &&
    onList &&
    (sig !== null
      ? true
      : band >= 0
        ? pick !== null
        : schedule !== undefined && scheduledOn(schedule, status.freqKhz!, serverNow()).length > 0);
  const pickCall = sig === null ? (pick?.call ?? null) : null;
  // What the question is about beyond the channel: the beacon's callsign or the station's
  // slug, or the slugs of the stations sharing the dial (#150).
  const pickId = sig !== null ? sig.map((a) => a.slug).join(TX_NAME_SEPARATOR) : pickCall;

  // When audio started on the picked beacon's channel (server time; the key
  // appears with first audio): what the prompt's rule counts from, and what the
  // band strip says was missed. A new pick counts from then. Null otherwise.
  const audioStart = useRef<number | null>(null);
  const [beaconAudioStartMs, setBeaconAudioStartMs] = useState<number | null>(null);
  // Bumped when the server-clock offset becomes known or is replaced after a
  // jump (lib/server-clock.ts). On a beacon frequency the plan below starts over
  // then, counting audio from that moment on the new clock, so the question and
  // the band strip (useServerTick) never work from two clocks; at worst the
  // question waits one more turn. Broadcasts are read on the same clock (#148 D14)
  // and aren't restarted.
  const [clockEpoch, setClockEpoch] = useState(0);
  // On every clock move, also close a beacon or signal-station prompt whose
  // answer the server would no longer take (it sat on screen through a sleep,
  // its timer paused).
  useEffect(
    () =>
      onServerOffset(() => {
        setClockEpoch((e) => e + 1);
        setPrompt((p) =>
          (p?.tx.kind === "beacon" &&
            p.tx.slotStartMs !== undefined &&
            serverNow() > p.tx.slotStartMs + LISTING_GRACE_MS - LATE_ANSWER_SLACK_MS) ||
          (p?.tx.kind === "signal" &&
            p.tx.answerByMs !== undefined &&
            serverNow() > p.tx.answerByMs - LATE_ANSWER_SLACK_MS)
            ? null
            : p,
        );
      }),
    [],
  );
  const pickClock = pickId !== null ? clockEpoch : 0;
  useEffect(() => {
    audioStart.current = key !== null && pickId !== null ? serverNow() : null;
    setBeaconAudioStartMs(pickCall !== null ? audioStart.current : null);
  }, [key, pickId, pickCall, band, pickClock]);

  // The beacon turn this plans to ask about (server time), null for none; and
  // whether the listener has turned questions off in this tab. The band strip
  // says when the turn it shows won't be asked about (noQuestionReason).
  const [beaconAskSlotMs, setBeaconAskSlotMs] = useState<number | null>(null);
  const [questionsOff, setQuestionsOff] = useState(false);

  useEffect(() => {
    if (key !== null) setPrompt((p) => (p && promptKey(p) !== key ? null : p));
    // One question per channel until it changes; on a beacon frequency, per
    // callsign too, as the server counts (another beacon picked is a new question);
    // likewise per signal station.
    const askKey = key !== null && pickId !== null ? `${key}:${pickId}` : key;
    if (askedOn.current !== askKey) askedOn.current = null;
    setBeaconAskSlotMs(null);
    if (askKey === null || !askable || askedOn.current === askKey) return;
    const c = (counts.current ??= loadCounts());
    if (c.dismissals >= MAX_DISMISSALS) {
      setQuestionsOff(true);
      return;
    }
    // Times saved by an older build were on the computer's clock, which can be
    // far ahead of the server's: none can be later than now.
    const asOfNow = (ms: number) => Math.min(ms, serverNow());
    let notBefore = asOfNow(c.lastShownMs) + PROMPT_GAP_MS;
    if (pickId !== null && audioStart.current !== null) {
      const s = latest.current.status;
      // An answer this tab sent about this beacon or station here (any of the stations a
      // shared-frequency question names, #150): the server takes the next one only after
      // SAME_CHANNEL_MS, so don't ask (and thank) before then.
      for (const id of pickId.split(TX_NAME_SEPARATOR)) {
        const sentAt =
          s.host && s.freqKhz !== undefined
            ? c.beacons?.[answerKey(s.host, s.port ?? DEFAULT_KIWI_PORT, s.freqKhz, id)]
            : undefined;
        if (sentAt !== undefined)
          notBefore = Math.max(notBefore, asOfNow(sentAt) + SAME_CHANNEL_MS + SAME_CHANNEL_SLACK_MS);
      }
    }
    const signalNow = latest.current.signal;
    const askList: readonly SignalAsk[] | null =
      signalNow === null ? null : "slug" in signalNow ? [signalNow] : signalNow.length > 0 ? signalNow : null;
    if (sigKey !== null && askList && audioStart.current !== null) {
      // A shared-frequency question is open until the first of its stations goes off.
      const ask: SignalAsk = { ...askList[0]!, untilMs: Math.min(...askList.map((a) => a.untilMs)) };
      // On the server's clock, as Priyom's times and the gaps are.
      const server = serverNow();
      const askAt = signalPromptAt(ask, audioStart.current, notBefore, DWELL_MS);
      if (askAt === null) return;
      const timer = setTimeout(() => {
        const s = latest.current.status;
        if (!s.host || s.freqKhz === undefined || !s.mode) return;
        // A timer that fired late (a sleep, or a frozen tab) after the station went
        // off: an answer could reach the server after it stops taking it.
        if (serverNow() > ask.untilMs + LATE_ANSWER_SLACK_MS) return;
        askedOn.current = askKey;
        update((c) => ({ ...c, lastShownMs: serverNow() }));
        setPrompt({
          host: s.host,
          port: s.port ?? DEFAULT_KIWI_PORT,
          freqKhz: s.freqKhz,
          mode: s.mode,
          tx: askList.length === 1 ? signalTransmitter(ask) : signalGroupTransmitter(askList),
        });
      }, askAt - server);
      return () => clearTimeout(timer);
    }
    if (pickCall !== null && audioStart.current !== null) {
      // The schedule and the gaps all run on the server's clock.
      const server = serverNow();
      const at = beaconPromptAt({ call: pickCall, bandIndex: band }, audioStart.current, notBefore);
      if (at === null) return;
      setBeaconAskSlotMs(at.slotStartMs);
      const timer = setTimeout(() => {
        const s = latest.current.status;
        if (!s.host || s.freqKhz === undefined || !s.mode) return;
        // A timer that fired late (a sleep, or a frozen tab): an answer about that
        // turn could reach the server after it stops taking it, allowing for the
        // clock's error and the trip. Plan a later turn instead.
        if (serverNow() > at.slotStartMs + LISTING_GRACE_MS - PROMPT_TTL_MS - LATE_ANSWER_SLACK_MS) {
          setClockEpoch((e) => e + 1);
          return;
        }
        askedOn.current = askKey;
        update((c) => ({ ...c, lastShownMs: serverNow() }));
        setPrompt({
          host: s.host,
          port: s.port ?? DEFAULT_KIWI_PORT,
          freqKhz: s.freqKhz,
          mode: s.mode,
          tx: beaconTransmitter({ call: pickCall, bandIndex: band }, at.slotStartMs),
        });
      }, at.askAtMs - server);
      return () => clearTimeout(timer);
    }
    const wait = Math.max(DWELL_MS, notBefore - serverNow());
    const timer = setTimeout(() => {
      const { status: s, schedule: sched, region: r } = latest.current;
      if (!sched || !s.host || s.freqKhz === undefined || !s.mode) return;
      // The listing may have ended during the wait.
      const listed = listedOn(sched, s.freqKhz, serverNow(), r);
      const tx = eibiTransmitter(listed, rankBroadcasts(listed, r), r);
      if (!tx) return;
      askedOn.current = askKey;
      update((c) => ({ ...c, lastShownMs: serverNow() }));
      setPrompt({ host: s.host, port: s.port ?? DEFAULT_KIWI_PORT, freqKhz: s.freqKhz, mode: s.mode, tx });
    }, wait);
    return () => clearTimeout(timer);
  }, [key, askable, pickCall, sigKey, band, update, pickClock]);

  // Unanswered for PROMPT_TTL_MS: the answer would no longer be taken.
  useEffect(() => {
    if (!prompt) return;
    const timer = setTimeout(() => setPrompt(null), PROMPT_TTL_MS);
    return () => clearTimeout(timer);
  }, [prompt]);

  /** The close button: counts toward MAX_DISMISSALS. */
  const dismiss = useCallback(() => {
    setPrompt(null);
    if (update((c) => ({ ...c, dismissals: c.dismissals + 1 })).dismissals >= MAX_DISMISSALS) setQuestionsOff(true);
  }, [update]);

  /**
   * Answered: goes away without counting as a dismissal, and thanks shows for
   * THANKS_MS. `sent` false: the answer filed nothing ("can't tell", #150), so
   * nothing holds the next question about these stations back.
   */
  const [thanked, setThanked] = useState(false);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const answered = useCallback((sent = true) => {
    const p = promptRef.current;
    // An answer about a beacon or signal station is sent: remember it, so this tab
    // doesn't ask about it here again before the server would take another (SAME_CHANNEL_MS).
    // A shared-frequency answer (#150) is about each station it names, unless it filed nothing.
    if ((p?.tx.kind === "beacon" || p?.tx.kind === "signal") && sent) {
      const now = serverNow();
      const names = p.tx.group ? p.tx.group.map((m) => m.slug) : [p.tx.name];
      update((c) => ({
        ...c,
        beacons: {
          ...Object.fromEntries(Object.entries(c.beacons ?? {}).filter(([, ms]) => now - ms < SAME_CHANNEL_MS)),
          ...Object.fromEntries(names.map((n) => [answerKey(p.host, p.port, p.freqKhz, n), now])),
        },
      }));
    }
    setPrompt(null);
    setThanked(true);
  }, [update]);
  useEffect(() => {
    if (!thanked) return;
    const timer = setTimeout(() => setThanked(false), THANKS_MS);
    return () => clearTimeout(timer);
  }, [thanked]);

  return { prompt, thanked, dismiss, answered, beaconAudioStartMs, beaconAskSlotMs, questionsOff };
}
