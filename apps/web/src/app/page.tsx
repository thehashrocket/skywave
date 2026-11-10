"use client";

import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dial } from "@/components/Dial";
import { FrequencyReadout } from "@/components/FrequencyReadout";
import { MapPanel } from "@/components/MapPanel";
import { Presets } from "@/components/Presets";
import { ReceiverPicker, type Playing } from "@/components/ReceiverPicker";
import { SignalList } from "@/components/SignalList";
import { SMeter } from "@/components/SMeter";
import { SpanPicker } from "@/components/SpanPicker";
import { Waterfall } from "@/components/Waterfall";
import { WideWaterfall } from "@/components/WideWaterfall";
import { ReceiverChip } from "@/components/ReceiverChip";
import { scheduledBetween, scheduledOn, stationLine } from "@/lib/eibi";
import { covers, findReceiver, placeName, rankReceivers, receiverKey, type Receiver } from "@/lib/kiwi-list";
import {
  MODE_LABELS,
  MODES,
  clampKhz,
  guessMode,
  inAmericas,
  inTuneRange,
  isMode,
  nearestKhz,
  PASSBANDS,
  tuningStepKhz,
  type Mode,
} from "@/lib/radio-types";
import { DEFAULT_KIWI_PORT, parseReceiver } from "@/lib/receiver";
import { usePickBest, WATCH_MS } from "@/lib/use-pick-best";
import { LIST_FAILED_TEXT, listFailed, useReceiverList } from "@/lib/use-receiver-list";
import { useBetterReceiver } from "@/lib/use-better-receiver";
import { useMapAdmission } from "@/lib/use-map-admission";
import { useRadio } from "@/lib/use-radio";
import { useSchedule } from "@/lib/use-schedule";
import { useSolarClock } from "@/lib/use-solar-clock";
import { bandAt, DEFAULT_SPAN, nextView, spanKhz, type SpanStep, type WideView } from "@/lib/wide-view";

// The last receiver that played, however it was reached. It seeds Back on the
// next visit; it no longer picks the receiver (Auto does, unless one is pinned).
const STORAGE_KEY = "skywave.receiver";
// The receiver the listener pinned, saved once it plays. Its own key, so a
// save from before pins existed never reads as one.
const PIN_KEY = "skywave.pin";
const TUNING_KEY = "skywave.tuning";
const DEFAULT_TUNING = { freqKhz: 10_000, mode: "am" as Mode };
// How long the dial rests before the frequency is saved.
const SAVE_TUNING_MS = 500;
const CW_PITCH_KHZ = 0.7;

/**
 * `fromList` marks a receiver from the public list, which the service dials
 * public-only; `secure` one that serves https only, dialed over wss://.
 */
type Saved = { host: string; port: string; fromList?: boolean; secure?: boolean };

/** A receiver to switch to: one from the list, or one heard earlier. */
type Target = { host: string; port: number; secure?: boolean; name?: string };

/** A receiver that played, so Back can return to it exactly as it was dialed. */
type Heard = { host: string; port: number; fromList: boolean; secure: boolean; label: string };

/** The last two receivers that played, for Back. */
type History = { last: Heard | null; previous: Heard | null };

/**
 * What the Receiver and Port fields hold. Separate from the receiver the page
 * is tuned to, so typing while listening never changes where dial moves go;
 * only Listen, Enter or Switch commits it.
 */
type Draft = { host: string; port: string; fromList: boolean; secure: boolean };

const BLANK_DRAFT: Draft = { host: "", port: String(DEFAULT_KIWI_PORT), fromList: false, secure: false };

function draftOf(r: Heard): Draft {
  return { host: r.host, port: String(r.port), fromList: r.fromList, secure: r.secure };
}

/** The newest receiver in the history that isn't the one with this key. */
function otherThan(h: History, key: string | undefined): Heard | null {
  return [h.last, h.previous].find((r) => r && receiverKey(r) !== key) ?? null;
}

function loadReceiver(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Anything could be stored here (an old format, a hand edit); use only a
    // value with the shape we write.
    const r: unknown = raw ? JSON.parse(raw) : null;
    if (r && typeof r === "object" && "host" in r && "port" in r) {
      const { host, port, fromList, secure } = r as Record<string, unknown>;
      if (typeof host === "string" && typeof port === "string") {
        return { host, port, ...(fromList === true && { fromList }), ...(secure === true && { secure }) };
      }
    }
  } catch {
    /* storage unavailable or unreadable; fall through */
  }
  return { host: "", port: String(DEFAULT_KIWI_PORT) };
}

function saveReceiver(r: Saved) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
  } catch {
    /* ignore */
  }
}

/** The frequency and mode last tuned, or the default for a first visit or a value we didn't write. */
function loadTuning(): { freqKhz: number; mode: Mode } {
  try {
    const raw = localStorage.getItem(TUNING_KEY);
    const t: unknown = raw ? JSON.parse(raw) : null;
    if (t && typeof t === "object" && "freqKhz" in t && "mode" in t) {
      const { freqKhz, mode } = t as Record<string, unknown>;
      if (typeof freqKhz === "number" && inTuneRange(freqKhz) && isMode(mode)) return { freqKhz, mode };
    }
  } catch {
    /* storage unavailable or unreadable; fall through */
  }
  return DEFAULT_TUNING;
}

function saveTuning(t: { freqKhz: number; mode: Mode }) {
  try {
    localStorage.setItem(TUNING_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}

function forgetReceiver() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** The pinned receiver, or null (Auto) for none or anything we didn't write. */
function loadPin(): Heard | null {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    const p: unknown = raw ? JSON.parse(raw) : null;
    if (p && typeof p === "object") {
      const { host, port, label, fromList, secure } = p as Record<string, unknown>;
      if (typeof host === "string" && host.trim() && typeof port === "number" && validPort(port) === String(port)) {
        return {
          host,
          port,
          fromList: fromList === true,
          secure: secure === true,
          label: typeof label === "string" && label.trim() ? label : host,
        };
      }
    }
  } catch {
    /* storage unavailable or unreadable; fall through */
  }
  return null;
}

function savePin(p: Heard) {
  try {
    localStorage.setItem(
      PIN_KEY,
      JSON.stringify({
        host: p.host,
        port: p.port,
        label: p.label,
        ...(p.fromList && { fromList: true }),
        ...(p.secure && { secure: true }),
      }),
    );
  } catch {
    /* ignore */
  }
}

function forgetPin() {
  try {
    localStorage.removeItem(PIN_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * A port the service can dial, as typed; anything else (0, 70000, empty) is the
 * Kiwi default. Digits only: Number() would also read a stored "0x1F90" or "1e3".
 */
function validPort(raw: string | number): string {
  const text = String(raw).trim();
  const p = /^\d+$/.test(text) ? Number(text) : NaN;
  return p >= 1 && p <= 65_535 ? String(p) : String(DEFAULT_KIWI_PORT);
}

/** The draft with a pasted URL split into host and port; a bare hostname keeps the scheme it had. */
function parseDraft(d: Draft): Draft {
  const parsed = parseReceiver(d.host);
  return {
    host: parsed.host,
    port: validPort(parsed.port ?? d.port.trim()),
    fromList: d.fromList,
    secure: parsed.secure ?? d.secure,
  };
}

function listSource(fromList: boolean) {
  return fromList ? { source: "list" as const } : {};
}

function wss(secure: boolean) {
  return secure ? { secure: true as const } : {};
}

/** False until `on` is first true, then true for good. */
function useLatch(on: boolean): boolean {
  const [latched, setLatched] = useState(false);
  // Set during render (React re-renders at once), so there's no frame with it still false.
  if (on && !latched) setLatched(true);
  return latched || on;
}

/**
 * Where the receiver's own waterfall looks for this width and frequency. It
 * holds still while the frequency moves inside it (the same object), so only
 * a move near an edge, or another width, asks the receiver for a new view.
 */
function useWideView(step: SpanStep, freqKhz: number): WideView | null {
  const [view, setView] = useState<WideView | null>(null);
  const next = nextView(step, freqKhz, view);
  if (next !== view) setView(next);
  return next;
}

const STATE_TEXT = {
  idle: "Not listening",
  connecting: "Connecting…",
  listening: "Listening",
  stopped: "Stopped",
  error: "Problem",
} as const;

/**
 * How long a receiver plays before its band scan starts and its own waterfall
 * is asked for (both are streams on the volunteer's Kiwi): long enough that a
 * quick switch or a receiver refusing apps (about 10 s in) isn't asked for
 * nothing. The radio service caches each receiver's scan.
 */
const AUTO_SCAN_MS = 10_000;

export default function ListenPage() {
  const radio = useRadio();
  const { status, meter, tune } = radio;
  const sun = useSolarClock();
  // The receiver the page is tuned to (or last was): where dial retunes go.
  // Only a tune sets it; the fields edit `draft`.
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_KIWI_PORT));
  // Whether that receiver came from the public list (the service dials it public-only).
  const [fromList, setFromList] = useState(false);
  // Whether that receiver serves https only, dialed over wss://.
  const [secure, setSecure] = useState(false);
  // The Receiver and Port fields. Typing a host clears fromList and secure, typing a port clears fromList.
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  // The receiver the listener chose; null is Auto (Listen picks the best for the frequency).
  const [pin, setPin] = useState<Heard | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  // The Back history. It changes only when a different receiver starts
  // playing, so retunes and errors keep it. Pick best reads it too, to return
  // to a receiver the page has moved on from.
  const [heard, setHeard] = useState<History>({ last: null, previous: null });
  const heardRef = useRef(heard);
  heardRef.current = heard;
  const [freqKhz, setFreqKhz] = useState(DEFAULT_TUNING.freqKhz);
  const [mode, setMode] = useState<Mode>(DEFAULT_TUNING.mode);
  // Not until the saved tuning is restored: saving first would overwrite it with the default.
  const [tuningRestored, setTuningRestored] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [browseOpen, setBrowseOpen] = useState(false);
  // The receiver drawer under the header strip: the Receiver field, Pick best, the map and the table.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  // Set when Pick best had no list to rank, shown in the status row. A fresh
  // object each press, so it's the newest message again; the text follows the
  // list as it loads or fails. `from` names the control to press again: after
  // the error link, Listen would redial the receiver that just failed.
  const [pageMessage, setPageMessage] = useState<{ from: "listen" | "link" } | null>(null);
  // Where focus goes when the error link starts a run and goes away.
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const p = loadPin();
    if (p) {
      setHost(p.host);
      setPort(String(p.port));
      setFromList(p.fromList);
      setSecure(p.secure);
      setPin(p);
      setDraft(draftOf(p));
    }
    // The last receiver heard doesn't pin anything; Back offers it.
    const last = loadReceiver();
    if (last.host) {
      const port = Number(validPort(last.port));
      setHeard({
        last: {
          host: last.host,
          port,
          fromList: last.fromList === true,
          secure: last.secure === true,
          label: last.host,
        },
        previous: null,
      });
    }
    // First visit: show the drawer and the list so there's something to pick from.
    const firstVisit = !p && !last.host;
    setBrowseOpen(firstVisit);
    setDrawerOpen(firstVisit);
    const t = loadTuning();
    setFreqKhz(t.freqKhz);
    setMode(t.mode);
    setTuningRestored(true);
  }, []);

  // Remember where the dial rests, listening or not, for the next visit.
  useEffect(() => {
    if (!tuningRestored) return;
    const timer = setTimeout(() => saveTuning({ freqKhz, mode }), SAVE_TUNING_MS);
    return () => clearTimeout(timer);
  }, [freqKhz, mode, tuningRestored]);

  const live = status.state === "listening" || status.state === "connecting";
  // A tune from idle or an error is under way before the service says so;
  // the form treats it as connecting.
  const starting = radio.tuning && !live;
  const busy = live || starting;
  const shownState = starting ? "connecting" : status.state;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Coalesce rapid dial drags into at most ~8 retunes a second.
  const pending = useRef<{ freqKhz: number; mode: Mode } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tuning = useRef({ host, port, fromList, secure });
  tuning.current = { host, port, fromList, secure };

  const sendRetune = useCallback(
    (next: { freqKhz: number; mode: Mode }) => {
      // While a tune starts, retune updates what it will send.
      if (!busy) return;
      pending.current = next;
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const p = pending.current;
        // The attempt may have failed while we waited; a retune now would dial it again.
        // A retune with no receiver would only be refused.
        if (!p || !busyRef.current || !tuning.current.host.trim()) return;
        radio.retune({
          host: tuning.current.host.trim(),
          port: Number(tuning.current.port) || DEFAULT_KIWI_PORT,
          ...p,
          ...listSource(tuning.current.fromList),
          ...wss(tuning.current.secure),
        });
      }, 120);
    },
    [busy, radio],
  );

  const changeFreq = useCallback(
    (khz: number, nextMode?: Mode) => {
      const m = nextMode ?? mode;
      setFreqKhz(khz);
      if (nextMode) setMode(nextMode);
      sendRetune({ freqKhz: khz, mode: m });
    },
    [mode, sendRetune],
  );

  const changeMode = (m: Mode) => {
    setMode(m);
    sendRetune({ freqKhz, mode: m });
  };

  // Pull a host and port out of a pasted URL like http://f4kiy.ddns.net:8073/.
  const normalizeDraft = () => {
    const r = parseDraft(draft);
    setDraft(r);
    return r;
  };

  // Stable so Pick best's retry effect doesn't re-run on every frequency change.
  const latest = useRef({ freqKhz, mode });
  latest.current = { freqKhz, mode };

  // The service has answered every tune sent while it played, so its tuning is
  // what plays: move the dial back if it refused or failed the last one. A
  // move still queued goes out next and gets its own answer.
  const { settled } = radio;
  useEffect(() => {
    if (!settled || timer.current) return;
    if (settled.freqKhz !== undefined && settled.freqKhz !== latest.current.freqKhz) setFreqKhz(settled.freqKhz);
    if (settled.mode !== undefined && settled.mode !== latest.current.mode) setMode(settled.mode);
  }, [settled]);
  // List names by host:port, so Back can say where it goes.
  const names = useRef(new Map<string, string>());
  const tuneReceiver = useCallback(
    (r: Target, fromList: boolean) => {
      // A dial retune still waiting on its timer would otherwise go to the old
      // receiver after this tune and switch the service back.
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
      if (r.name) names.current.set(receiverKey(r), r.name);
      setPageMessage(null);
      const secure = r.secure === true;
      tuning.current = { host: r.host, port: String(r.port), fromList, secure };
      setHost(r.host);
      setPort(String(r.port));
      setFromList(fromList);
      setSecure(secure);
      // Works while listening too: the radio service switches receivers.
      void tune({ host: r.host, port: r.port, ...latest.current, ...listSource(fromList), ...wss(secure) });
    },
    [tune],
  );
  // The dial can move during a run; only try receivers that still cover it.
  const coversDial = useCallback((r: Receiver) => covers(r, latest.current.freqKhz), []);
  /** Whether host:port is what the page is tuned to: the only receiver whose list tag and scheme we know. */
  const isTarget = useCallback((h: string, p: number) => {
    const t = tuning.current;
    return t.host === h && Number(t.port) === p;
  }, []);
  const provenance = useCallback(
    (h: string, p: number) => {
      const t = tuning.current;
      if (isTarget(h, p)) return { fromList: t.fromList, secure: t.secure };
      const { last, previous } = heardRef.current;
      const known = [last, previous].find((r) => r && r.host === h && r.port === p);
      return known ? { fromList: known.fromList, secure: known.secure } : { fromList: false, secure: false };
    },
    [isTarget],
  );
  const pickBest = usePickBest(status, tuneReceiver, coversDial, provenance);
  const { cancel: cancelPickBest, stop: stopPickBest, start: startPicking } = pickBest;
  const list = useReceiverList();
  const receivers = list.data?.receivers;
  const listGone = listFailed(list);
  const lastSavedPin = useRef<Heard | null>(null);
  /**
   * Back to Auto. Only the choice changes: nothing is tuned or stopped, and
   * dial retunes keep going to the receiver that plays.
   */
  const clearPin = useCallback(() => {
    setPin(null);
    setDraft(BLANK_DRAFT);
    forgetPin();
    lastSavedPin.current = null;
  }, []);
  // Asking skywave to choose (Pick best, blank Listen, the error link, the
  // better-receiver offer) is Auto, so a run that starts ends any pin.
  const pickFrom = useCallback(
    (ranked: Receiver[], known?: readonly Receiver[]) => {
      setPageMessage(null);
      const started = startPicking(ranked, known);
      if (started) clearPin();
      return started;
    },
    [startPicking, clearPin],
  );
  /**
   * Pick best from outside the Receivers section (a blank Listen, the error
   * link): with no list to rank, say why instead of reporting that nothing
   * covers the frequency.
   */
  const startPickBest = useCallback(
    (from: "listen" | "link"): boolean => {
      if (receivers) return pickFrom(rankReceivers(receivers, latest.current.freqKhz));
      setPageMessage({ from });
      // The message points at the Receiver field and Try again, which are in the drawer.
      setDrawerOpen(true);
      return false;
    },
    [receivers, pickFrom],
  );
  // The list arriving (or coming back) answers "still loading" and "couldn't load".
  useEffect(() => {
    if (receivers) setPageMessage(null);
  }, [receivers]);
  // With nothing to go back to, stop the attempt that's still connecting too.
  const stopPicking = useCallback(() => {
    if (!stopPickBest()) radio.stop();
  }, [stopPickBest, radio]);
  /** Ends any Pick best run, then tunes. Leaves the pin as it is (pinTo sets it). */
  const switchTo = useCallback(
    (r: Target, fromList: boolean) => {
      cancelPickBest();
      tuneReceiver(r, fromList);
    },
    [cancelPickBest, tuneReceiver],
  );
  /** The listener chose this receiver (the table, the map, a typed address): pin it and switch. */
  const pinTo = useCallback(
    (r: Target, fromList: boolean) => {
      const p: Heard = {
        host: r.host,
        port: r.port,
        fromList,
        secure: r.secure === true,
        label: r.name ?? names.current.get(receiverKey(r)) ?? r.host,
      };
      setPin(p);
      setDraft(draftOf(p));
      switchTo(r, fromList);
    },
    [switchTo],
  );
  /**
   * A choice made in the drawer closes it. Focus inside it would vanish with
   * it, so it goes to "change", which opens it again.
   */
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    if (drawerRef.current?.contains(document.activeElement)) changeRef.current?.focus();
  }, []);
  const chooseReceiver = useCallback(
    (r: Receiver) => {
      pinTo(r, true);
      closeDrawer();
    },
    [pinTo, closeDrawer],
  );
  /** Pins and tunes what the fields say. Unchanged fields keep the pin's name. */
  const commitDraft = () => {
    const d = normalizeDraft();
    const port = Number(d.port);
    const same = pin && receiverKey(pin) === receiverKey({ host: d.host, port });
    pinTo({ host: d.host, port, secure: d.secure, ...(same && { name: pin.label }) }, d.fromList);
    closeDrawer();
  };
  // The table's dot marks what's playing (or connecting), not what the fields
  // say. From the click until the service answers, that's the receiver being
  // tuned: the status still names the old one.
  const pendingHost = radio.tuning ? host : undefined;
  const pendingPort = radio.tuning ? Number(port) || DEFAULT_KIWI_PORT : undefined;
  const playingHost = pendingHost ?? (live ? status.host : undefined);
  const playingPort = pendingPort ?? (live ? status.port : undefined);
  const playingPhase = radio.tuning ? "connecting" : live ? (status.state as Playing["phase"]) : undefined;
  const current = useMemo(
    () =>
      playingHost && playingPort && playingPhase ? { host: playingHost, port: playingPort, phase: playingPhase } : null,
    [playingHost, playingPort, playingPhase],
  );

  // Remember a receiver only once it actually plays, so a typo or a failed
  // Pick best run never becomes the saved default. Only the receiver the page
  // is tuned to: a late "listening" from an attempt Pick best already left
  // isn't one we know the list tag of.
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    if (status.state !== "listening" || !status.host || !isTarget(status.host, status.port ?? DEFAULT_KIWI_PORT))
      return;
    const t = tuning.current;
    const target = { host: t.host, port: Number(t.port) };
    const playing: Heard = {
      ...target,
      fromList: t.fromList,
      secure: t.secure,
      label: names.current.get(receiverKey(target)) ?? t.host,
    };
    setHeard((h) => {
      const key = receiverKey(playing);
      if (h.last && receiverKey(h.last) === key) {
        // The same receiver again; keep how it was reached this time.
        const same =
          h.last.fromList === playing.fromList && h.last.secure === playing.secure && h.last.label === playing.label;
        return same ? h : { ...h, last: playing };
      }
      // With no last (a refused one was dropped), the previous one stays, unless it's this one.
      return { last: playing, previous: otherThan(h, key) };
    });
    // The pin too, once it plays: a typo or a receiver that refuses is never saved as one.
    const p = pinRef.current;
    if (p && p !== lastSavedPin.current && receiverKey(p) === receiverKey(target)) {
      lastSavedPin.current = p;
      savePin(p);
    }
    const saved = JSON.stringify({
      host: t.host,
      port: t.port,
      ...(t.fromList && { fromList: true }),
      ...(t.secure && { secure: true }),
    } satisfies Saved);
    // Each retune while listening is a new status; don't rewrite the same value.
    if (saved === lastSaved.current) return;
    lastSaved.current = saved;
    saveReceiver(JSON.parse(saved));
  }, [status, isTarget]);

  // A receiver that only takes listeners on its own web page plays for about
  // 10 s before it refuses, so by then it's saved. It will refuse every time;
  // don't offer it as the default again.
  useEffect(() => {
    if (status.state !== "error" || status.code !== "no_apps" || !status.host) return;
    // Nor as the place Back goes.
    const refused = receiverKey({ host: status.host, port: status.port ?? DEFAULT_KIWI_PORT });
    const keep = (r: Heard | null) => (r && receiverKey(r) === refused ? null : r);
    setHeard((h) => ({ last: keep(h.last), previous: keep(h.previous) }));
    // A pin on it goes back to Auto: it would refuse every Listen.
    const pinned = pinRef.current ?? loadPin();
    if (pinned && receiverKey(pinned) === refused) clearPin();
    const saved = loadReceiver();
    if (saved.host !== status.host || Number(saved.port) !== (status.port ?? DEFAULT_KIWI_PORT)) return;
    forgetReceiver();
    lastSaved.current = null;
  }, [status, clearPin]);

  // The receiver playing now, as the service names it.
  const playingNow = useMemo(
    () =>
      status.state === "listening" && status.host
        ? { host: status.host, port: status.port ?? DEFAULT_KIWI_PORT }
        : null,
    [status.state, status.host, status.port],
  );

  // Back goes to the last receiver that played, unless the page is showing
  // that one; then to the one before. "Showing" is the receiver playing or
  // connecting, else the one the status names (a failed switch), else the one
  // in the fields (after Stop, or when the service drops). So a switch that
  // fails or is stopped offers the receiver you were just hearing.
  const fieldsHost = host.trim();
  const fieldsPort = Number(validPort(port));
  const backTo = useMemo(() => {
    const shown =
      current ??
      (status.host ? { host: status.host, port: status.port ?? DEFAULT_KIWI_PORT } : null) ??
      (fieldsHost ? { host: fieldsHost, port: fieldsPort } : null);
    return otherThan(heard, shown ? receiverKey(shown) : undefined);
  }, [heard, current, status.host, status.port, fieldsHost, fieldsPort]);

  // A receiver earns its scan and its own waterfall once it has played for
  // AUTO_SCAN_MS and Pick best is done with it: not during its attempts, nor
  // its watch for a late refusal. Any other receiver, or none, starts over.
  const { canScan, scan, startScan } = radio;
  const playingKey = playingNow && receiverKey(playingNow);
  const scannedKey = scan ? receiverKey(scan) : null;
  const [settledKey, setSettledKey] = useState<string | null>(null);
  if (settledKey !== null && settledKey !== playingKey) setSettledKey(null);
  const settledHere = settledKey !== null && settledKey === playingKey;
  useEffect(() => {
    if (!playingKey || !radio.heardAudio || !pickBest.settled || settledKey === playingKey) return;
    const timer = setTimeout(() => setSettledKey(playingKey), AUTO_SCAN_MS);
    return () => clearTimeout(timer);
  }, [playingKey, settledKey, radio.heardAudio, pickBest.settled]);
  useEffect(() => {
    if (settledHere && canScan && scannedKey !== playingKey) startScan();
  }, [settledHere, canScan, scannedKey, playingKey, startScan]);

  // The map waits for the radio: the session's first audio, or 5 s with nothing to wait for.
  const mapAdmitted = useMapAdmission({ heardAudio: radio.heardAudio, busy });
  // Nor before the drawer has opened once: a map that loads unseen can't be
  // checked for drawing. Once loaded it stays, closed or not.
  const drawerSeen = useLatch(drawerOpen);
  const lastPlace = useMemo(() => backTo && { host: backTo.host, port: backTo.port }, [backTo]);
  const openBrowse = useCallback(() => {
    setBrowseOpen(true);
    document.querySelector<HTMLElement>(".receivers-browse summary")?.focus();
  }, []);

  const onDial = useCallback(
    (khz: number) => {
      // Dragging across band edges picks the conventional mode for you.
      const suggested = guessMode(khz);
      changeFreq(khz, suggested !== guessMode(freqKhz) ? suggested : undefined);
    },
    [changeFreq, freqKhz],
  );

  const onWaterfallClick = (hz: number) => {
    const base = mode === "cw" ? freqKhz - CW_PITCH_KHZ : freqKhz;
    changeFreq(clampKhz(Math.round((base + hz / 1000) * 100) / 100));
  };

  // "Switch to a better receiver?" once the dial rests somewhere the receiver
  // playing can't tune, or after a big move with a much stronger one listed.
  // Only offered; the button switches, and through Pick best, so a switch that
  // fails goes back to this receiver.
  const {
    offer,
    dismiss: dismissOffer,
    excluded,
  } = useBetterReceiver({
    enabled: playingNow !== null && !radio.tuning && pickBest.settled,
    receivers,
    playing: playingNow,
    freqKhz,
    isRefused: pickBest.isRefused,
  });
  // The offered receiver first, then the rest that cover the dial, minus the
  // one playing and any it would leave out; the whole list names the way back.
  const switchToBetter = () => {
    if (!offer || !receivers) return;
    const skip = new Set([receiverKey(offer.playing), receiverKey(offer.target)]);
    const rest = rankReceivers(receivers, latest.current.freqKhz).filter(
      (r) => !skip.has(receiverKey(r)) && !excluded(r),
    );
    dismissOffer();
    pickFrom([offer.target, ...rest], receivers);
    // The prompt (and the button) goes away; the status row reports the switch.
    statusRef.current?.focus();
  };

  // A typed address that isn't what's tuned can be switched to while listening.
  const typed = draft.host.trim() ? parseDraft(draft) : null;
  const canSwitch = busy && typed !== null && !isTarget(typed.host, Number(typed.port));

  // While listening, Enter in a field switches to what it says (or does
  // nothing); it never means Stop, which is the button's job.
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !busy) return;
    e.preventDefault();
    if (canSwitch) commitDraft();
  };

  // The status row shows whichever message is newest: Pick best's note, the
  // service's message, or the page's own. A finished run's note doesn't hide
  // what happens next, and a new press isn't hidden by an older failure.
  const [newest, setNewest] = useState<"note" | "service" | "page" | null>(null);
  useEffect(() => {
    if (pickBest.note) setNewest("note");
  }, [pickBest.note]);
  useEffect(() => {
    if (status.message) setNewest("service");
  }, [status]);
  useEffect(() => {
    if (pageMessage) setNewest("page");
  }, [pageMessage]);
  const serviceMessage = starting ? undefined : status.message;
  const messages = {
    note: pickBest.note,
    service: serviceMessage,
    page:
      pageMessage &&
      (listGone
        ? `${LIST_FAILED_TEXT} Paste a receiver address, or try again below.`
        : `The receiver list is still loading. Press ${pageMessage.from === "link" ? "Pick best receiver" : "Listen"} again in a moment.`),
  };
  // While a run is going, only its note shows: it names each refusal and
  // what's next, and the bare refusal lands a render before the note does.
  const source = pickBest.running ? "note" : newest && messages[newest] ? newest : "service";
  const message = messages[source];
  const messageTone =
    source === "service"
      ? status.state === "error"
      : // A note reads as a failure only once nothing plays or connects (not while going back).
        source === "note" && !pickBest.running && !busy;

  // The receiver playing, as the list knows it (none for a typed one).
  const playingListed = useMemo(
    () => (playingNow ? findReceiver(receivers, playingNow.host, playingNow.port) : undefined),
    [receivers, playingNow],
  );
  // Where it is, when the list says.
  const listedPlace = playingListed ? placeName(playingListed.location) : "";
  // One wheel notch over the readout. Medium wave channels are 10 kHz apart in
  // the Americas, 9 elsewhere: go by where the receiver playing is, 9 if unknown.
  const wheelStep = tuningStepKhz(freqKhz, mode, inAmericas(playingListed?.lon));

  // The waterfall opens on the visit's first audio and stays open, so Stop and
  // Listen never resize it again.
  const waterfallOpen = useLatch(radio.heardAudio);

  // How wide the waterfall looks. The receiver's own waterfall needs a radio
  // service that streams it; "band" needs the dial in a band, and falls back
  // to the default width when it leaves one.
  const [spanStep, setSpanStep] = useState<SpanStep>(DEFAULT_SPAN);
  const dialBand = bandAt(freqKhz);
  if (spanStep === "band" && !dialBand) setSpanStep(DEFAULT_SPAN);
  const wideView = useWideView(spanStep, freqKhz);
  // Only once the receiver playing has earned it (the scan's wait, above);
  // until then, and after an error or Stop, the audio waterfall shows.
  const showWide = waterfallOpen && radio.canView && wideView !== null && settledHere;
  // Waiting for that, with a wide width chosen: the picker says so.
  const wideWaiting = radio.canView && wideView !== null && !settledHere && (busy || playingNow !== null);
  const { showView } = radio;
  useEffect(() => {
    showView(showWide ? wideView : null);
  }, [showView, showWide, wideView]);
  // Where the Kiwi is tuned (CW sits below the signal, at its pitch) and what it passes, in RF.
  const kiwiKhz = mode === "cw" ? freqKhz - CW_PITCH_KHZ : freqKhz;
  const passband: [number, number] = [kiwiKhz + PASSBANDS[mode][0] / 1000, kiwiKhz + PASSBANDS[mode][1] / 1000];

  // Station names from the EiBi schedule, by the minute: nothing until the page
  // has the schedule and its own clock (the server's time isn't the viewer's).
  const schedule = useSchedule().data?.broadcasts;
  const clock = sun?.at ?? null;
  const stationNow = useMemo(
    () => (schedule && clock !== null ? stationLine(scheduledOn(schedule, freqKhz, clock)) : null),
    [schedule, clock, freqKhz],
  );
  const stationAt = useCallback(
    (khz: number) => (schedule && clock !== null ? stationLine(scheduledOn(schedule, khz, clock)) : null),
    [schedule, clock],
  );
  const wideStations = useMemo(() => {
    if (!schedule || clock === null || !wideView) return [];
    // Twice the view's width: a receiver can show a view off-centre, near the edge of what it covers.
    const span = spanKhz(wideView.zoom);
    return scheduledBetween(schedule, wideView.cfKhz - span, wideView.cfKhz + span, clock).map((c) => ({
      khz: c.khz,
      line: stationLine(c.broadcasts)!,
    }));
  }, [schedule, clock, wideView]);

  return (
    <main className="console">
      <header className="console-header">
        <h1 className="wordmark">skywave</h1>
        <div className="tuned-to">
          {playingNow ? (
            <span className="tuned-to-text">
              Listening via <span className="tuned-to-place">{listedPlace || playingNow.host}</span>
              {listedPlace && <span className="tuned-to-host"> · {playingNow.host}</span>}
            </span>
          ) : (
            <ReceiverChip pinned={pin?.label ?? null} />
          )}
          <button
            ref={changeRef}
            type="button"
            className="link-button inline tuned-to-change"
            aria-label="Change receiver"
            aria-expanded={drawerOpen}
            aria-controls="receiver-drawer"
            onClick={() => setDrawerOpen((o) => !o)}
          >
            change
          </button>
        </div>
        {/* The receiver form's submit button, kept in the strip so it's always in reach. */}
        <button
          type="submit"
          form="receiver-form"
          className={busy ? "power power-on" : "power"}
          onClick={(e) => {
            // Listen turns into Stop at once; the second click of a
            // double-click mustn't stop what the first one started.
            if (e.detail > 1) e.preventDefault();
          }}
        >
          {busy ? "Stop" : "Listen"}
        </button>
      </header>

      <section
        id="receiver-drawer"
        ref={drawerRef}
        className="drawer"
        aria-label="Choose a receiver"
        inert={!drawerOpen}
      >
        <form
          id="receiver-form"
          className="receiver"
          onSubmit={(e) => {
            e.preventDefault();
            cancelPickBest();
            if (busy) radio.stop();
            // A blank receiver is Auto: skywave picks one.
            else if (!draft.host.trim()) startPickBest("listen");
            else commitDraft();
          }}
        >
          <div className="field field-host">
            {/* The choice and the hint sit on the label row (wrapping when narrow), not under the
                  input, so the form's inputs stay bottom-aligned; unlike a placeholder, the hint stays
                  visible once an address is typed. */}
            <div className="field-head">
              <label htmlFor="host">Receiver</label>
              <ReceiverChip
                id="host-choice"
                pinned={pin?.label ?? null}
                onUnpin={() => {
                  clearPin();
                  // The ✕ goes away with the pin; leave focus where an address is typed.
                  document.getElementById("host")?.focus();
                }}
              />
              <span id="host-hint" className="field-hint">
                or type an address
              </span>
            </div>
            <input
              id="host"
              aria-describedby="host-choice host-hint"
              value={draft.host}
              onChange={(e) => setDraft((d) => ({ ...d, host: e.target.value, fromList: false, secure: false }))}
              onBlur={normalizeDraft}
              onKeyDown={onFieldKey}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="field field-port">
            <label htmlFor="port">Port</label>
            <input
              id="port"
              value={draft.port}
              onChange={(e) => setDraft((d) => ({ ...d, port: e.target.value.replace(/\D/g, ""), fromList: false }))}
              onKeyDown={onFieldKey}
              inputMode="numeric"
            />
          </div>
          {canSwitch && (
            <button
              type="button"
              className="receiver-switch"
              onClick={(e) => {
                if (e.detail <= 1) commitDraft();
              }}
            >
              Switch
            </button>
          )}
        </form>
        <ReceiverPicker
          freqKhz={freqKhz}
          current={current}
          sun={sun}
          open={browseOpen}
          onOpenChange={setBrowseOpen}
          onChoose={chooseReceiver}
          onPickBest={(ranked) => {
            const started = pickFrom(ranked);
            if (started) closeDrawer();
            return started;
          }}
          picking={pickBest.running}
          onStopPicking={stopPicking}
          map={(list) => (
            <MapPanel
              admitted={mapAdmitted && drawerSeen}
              list={list}
              freqKhz={freqKhz}
              sun={sun}
              playing={current}
              last={lastPlace}
              onListen={chooseReceiver}
              onBrowse={openBrowse}
            />
          )}
        >
          <p className="receiver-help">
            Let skywave pick a receiver, choose one from the list, or paste any address from{" "}
            <a href="http://kiwisdr.com/public/" target="_blank" rel="noreferrer">
              kiwisdr.com/public
            </a>
            . They're run by volunteers and most allow only a handful of listeners, so stop when you're done.
          </p>
        </ReceiverPicker>
      </section>

      <h2 className="visually-hidden">Tuner</h2>
      {/* Compact from the visit's first audio, with the waterfall opening: one change, then it stays. */}
      <Dial freqKhz={freqKhz} onChange={onDial} compact={waterfallOpen} />

      <section className="controls" aria-label="Tuning">
        <FrequencyReadout freqKhz={freqKhz} onChange={(k) => changeFreq(k)} step={wheelStep} station={stationNow} />

        <fieldset className="modes">
          <legend className="visually-hidden">Mode</legend>
          {MODES.map((m) => (
            <label key={m} className="mode">
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => changeMode(m)} />
              <span>{MODE_LABELS[m]}</span>
            </label>
          ))}
        </fieldset>

        <SMeter meter={meter} />

        <div className="volume">
          <label htmlFor="volume">Volume</label>
          <input
            id="volume"
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={volume}
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolume(v);
              radio.setVolume(v);
            }}
          />
        </div>
      </section>

      <div className="status-row">
        <div className="status" role="status" data-state={shownState} ref={statusRef} tabIndex={-1}>
          <span className="status-lamp" aria-hidden="true" />
          <span className="status-state">{STATE_TEXT[shownState]}</span>
          {/* The strip shows where; this live region says it too, so a switch is heard. */}
          {playingNow && <span className="visually-hidden"> via {listedPlace || playingNow.host}</span>}
          {message && (
            <span className="status-message" data-tone={messageTone ? "danger" : undefined}>
              {message}
            </span>
          )}
        </div>
        {/* Outside the live region, so a new Back target isn't announced. */}
        {backTo && (
          <button
            type="button"
            className="link-button status-back"
            onClick={(e) => {
              // The button flips to the receiver just left; a double-click would switch straight back.
              if (e.detail > 1) return;
              // Back is undo, not a new choice: a pin moves with it, Auto stays Auto.
              if (pin) pinTo({ ...backTo, name: backTo.label }, backTo.fromList);
              else switchTo(backTo, backTo.fromList);
            }}
          >
            Back to {backTo.label}
          </button>
        )}
        {/* Only once nothing else is handling the error: not during a run, nor its watch for a late refusal. */}
        {/* Only a receiver's own (coded) error: the service rejecting a tune, a down service or blocked audio isn't the receiver's fault. */}
        {status.state === "error" && status.host && status.code && !starting && pickBest.settled && (
          <button
            type="button"
            className="link-button status-pick"
            onClick={(e) => {
              if (e.detail > 1) return;
              // A run hides this link; keep focus on the row that reports it.
              if (startPickBest("link")) statusRef.current?.focus();
            }}
          >
            Pick best receiver
          </button>
        )}
      </div>

      {/* Always rendered, so a screen reader hears the offer when it appears; its line is reserved so nothing moves. */}
      <div className="switch-prompt" role="status">
        {offer && (
          <>
            <span>
              {offer.reason === "uncovered"
                ? `${offer.playing.name} can't tune ${freqKhz.toLocaleString("en-US", { maximumFractionDigits: 2 })} kHz.`
                : `${offer.target.name} is listed ${offer.gapDb} dB stronger.`}{" "}
              Switch to a better receiver?
            </span>
            <button
              type="button"
              className="link-button inline"
              onClick={(e) => {
                if (e.detail <= 1) switchToBetter();
              }}
            >
              Switch to {offer.target.name}
            </button>
            <button
              type="button"
              className="link-button inline"
              onClick={() => {
                dismissOffer();
                // The button goes away with the offer; leave focus on the status row beside it.
                statusRef.current?.focus();
              }}
            >
              Not now
            </button>
          </>
        )}
      </div>

      <h2 className="visually-hidden">Waterfall</h2>
      {waterfallOpen && (
        <SpanPicker
          step={radio.canView ? spanStep : "audio"}
          waiting={wideWaiting}
          band={dialBand}
          canView={radio.canView}
          onChange={setSpanStep}
        />
      )}
      {showWide ? (
        <WideWaterfall
          // A receiver of its own: a switch starts a blank picture, not the last one's.
          key={playingKey ?? "none"}
          view={wideView}
          freqKhz={freqKhz}
          passband={passband}
          frozen={scan?.state === "scanning"}
          error={radio.viewError}
          subscribe={radio.onWideFrame}
          // On the channel grid the wheel steps on, so a click lands on the station.
          onTune={(khz) => changeFreq(nearestKhz(khz, wheelStep))}
          stations={wideStations}
        />
      ) : (
        <Waterfall
          expanded={waterfallOpen}
          connecting={busy}
          mode={mode}
          sampleRate={status.sampleRate ?? 12000}
          active={status.state === "listening"}
          subscribe={radio.onSpectrum}
          onClickOffset={onWaterfallClick}
        />
      )}

      <SignalList
        scan={scan}
        canScan={canScan}
        listening={status.state === "listening"}
        freqKhz={freqKhz}
        scanDelayMs={pickBest.settled ? AUTO_SCAN_MS : WATCH_MS + AUTO_SCAN_MS}
        checking={!pickBest.settled}
        onTune={(khz) => changeFreq(khz, "am")}
        onScanAgain={() => startScan(true)}
        stationAt={stationAt}
      />

      <Presets freqKhz={freqKhz} mode={mode} onSelect={(p) => changeFreq(clampKhz(p.freqKhz), p.mode)} />
    </main>
  );
}
