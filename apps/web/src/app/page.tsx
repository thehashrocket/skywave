"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dial } from "@/components/Dial";
import { FrequencyReadout } from "@/components/FrequencyReadout";
import { Presets } from "@/components/Presets";
import { ReceiverPicker, type Playing } from "@/components/ReceiverPicker";
import { SMeter } from "@/components/SMeter";
import { Waterfall } from "@/components/Waterfall";
import { covers, type Receiver } from "@/lib/kiwi-list";
import { MODE_LABELS, MODES, guessMode, type Mode } from "@/lib/radio-types";
import { DEFAULT_KIWI_PORT, parseReceiver } from "@/lib/receiver";
import { usePickBest } from "@/lib/use-pick-best";
import { useRadio } from "@/lib/use-radio";
import { useSolarClock } from "@/lib/use-solar-clock";

const STORAGE_KEY = "skywave.receiver";
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

function forgetReceiver() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function listSource(fromList: boolean) {
  return fromList ? { source: "list" as const } : {};
}

function wss(secure: boolean) {
  return secure ? { secure: true as const } : {};
}

const STATE_TEXT = {
  idle: "Not listening",
  connecting: "Connecting…",
  listening: "Listening",
  stopped: "Stopped",
  error: "Problem",
} as const;

export default function ListenPage() {
  const radio = useRadio();
  const { status, meter, tune } = radio;
  const sun = useSolarClock();
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_KIWI_PORT));
  // Whether host/port came from the public list. Typing in either field clears it.
  const [fromList, setFromList] = useState(false);
  // Whether the receiver serves https only. Set from a pasted https:// URL or a
  // list entry; typing a new host clears it.
  const [secure, setSecure] = useState(false);
  const [freqKhz, setFreqKhz] = useState(10_000);
  const [mode, setMode] = useState<Mode>("am");
  const [volume, setVolume] = useState(0.8);
  const [browseOpen, setBrowseOpen] = useState(false);

  useEffect(() => {
    const r = loadReceiver();
    setHost(r.host);
    setPort(r.port);
    setFromList(r.fromList === true);
    setSecure(r.secure === true);
    // First visit: show the list so there's something to pick from.
    setBrowseOpen(!r.host);
  }, []);

  const live = status.state === "listening" || status.state === "connecting";
  const liveRef = useRef(live);
  liveRef.current = live;

  // Coalesce rapid dial drags into at most ~8 retunes a second.
  const pending = useRef<{ freqKhz: number; mode: Mode } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tuning = useRef({ host, port, fromList, secure });
  tuning.current = { host, port, fromList, secure };

  const sendRetune = useCallback(
    (next: { freqKhz: number; mode: Mode }) => {
      if (!live) return;
      pending.current = next;
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const p = pending.current;
        // The attempt may have failed while we waited; a retune now would dial it again.
        if (!p || !liveRef.current) return;
        radio.retune({
          host: tuning.current.host.trim(),
          port: Number(tuning.current.port) || DEFAULT_KIWI_PORT,
          ...p,
          ...listSource(tuning.current.fromList),
          ...wss(tuning.current.secure),
        });
      }, 120);
    },
    [live, radio],
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
  const normalizeReceiver = () => {
    const parsed = parseReceiver(host);
    const r = {
      host: parsed.host,
      port: parsed.port ?? (port.trim() || String(DEFAULT_KIWI_PORT)),
      // A bare hostname (including one we already took out of a URL) keeps the scheme it had.
      secure: parsed.secure ?? secure,
    };
    setHost(r.host);
    setPort(r.port);
    setSecure(r.secure);
    return r;
  };

  const listen = () => {
    const r = normalizeReceiver();
    void tune({ host: r.host, port: Number(r.port), freqKhz, mode, ...listSource(fromList), ...wss(r.secure) });
  };

  // Stable so Pick best's retry effect doesn't re-run on every frequency change.
  const latest = useRef({ freqKhz, mode });
  latest.current = { freqKhz, mode };
  // List names by host:port, so Back can say where it goes.
  const names = useRef(new Map<string, string>());
  const tuneReceiver = useCallback(
    (r: Target, fromList: boolean) => {
      // A dial retune still waiting on its timer would otherwise go to the old
      // receiver after this tune and switch the service back.
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
      if (r.name) names.current.set(`${r.host}:${r.port}`, r.name);
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
      return isTarget(h, p) ? { fromList: t.fromList, secure: t.secure } : { fromList: false, secure: false };
    },
    [isTarget],
  );
  const pickBest = usePickBest(status, tuneReceiver, coversDial, provenance);
  const { cancel: cancelPickBest, stop: stopPickBest } = pickBest;
  // With nothing to go back to, stop the attempt that's still connecting too.
  const stopPicking = useCallback(() => {
    if (!stopPickBest()) radio.stop();
  }, [stopPickBest, radio]);
  /** The one way the page changes receiver on the user's say-so: the table, and Back. */
  const switchTo = useCallback(
    (r: Target, fromList: boolean) => {
      cancelPickBest();
      tuneReceiver(r, fromList);
    },
    [cancelPickBest, tuneReceiver],
  );
  const chooseReceiver = useCallback((r: Receiver) => switchTo(r, true), [switchTo]);
  // The table's dot marks what's playing (or connecting), not what the fields say.
  const playingHost = live ? status.host : undefined;
  const playingPort = live ? status.port : undefined;
  const playingPhase = live ? (status.state as Playing["phase"]) : undefined;
  const current = useMemo(
    () =>
      playingHost && playingPort && playingPhase ? { host: playingHost, port: playingPort, phase: playingPhase } : null,
    [playingHost, playingPort, playingPhase],
  );

  // The receiver that played before this one, for Back. It changes only when
  // a different receiver starts playing, so retunes and errors keep it.
  const [previous, setPrevious] = useState<Heard | null>(null);
  const lastHeard = useRef<Heard | null>(null);

  // Remember a receiver only once it actually plays, so a typo or a failed
  // Pick best run never becomes the saved default. Only the receiver the page
  // is tuned to: a late "listening" from an attempt Pick best already left
  // isn't one we know the list tag of.
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    if (status.state !== "listening" || !status.host || !isTarget(status.host, status.port ?? DEFAULT_KIWI_PORT))
      return;
    const t = tuning.current;
    const heard: Heard = {
      host: t.host,
      port: Number(t.port),
      fromList: t.fromList,
      secure: t.secure,
      label: names.current.get(`${t.host}:${Number(t.port)}`) ?? t.host,
    };
    const last = lastHeard.current;
    if (!last || last.host !== heard.host || last.port !== heard.port) {
      if (last) setPrevious(last);
      lastHeard.current = heard;
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
    const saved = loadReceiver();
    if (saved.host !== status.host || Number(saved.port) !== (status.port ?? DEFAULT_KIWI_PORT)) return;
    forgetReceiver();
    lastSaved.current = null;
  }, [status]);

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
    changeFreq(Math.round((base + hz / 1000) * 100) / 100);
  };

  return (
    <main className="console">
      <header className="console-header">
        <h1 className="wordmark">skywave</h1>
        <form
          className="receiver"
          onSubmit={(e) => {
            e.preventDefault();
            cancelPickBest();
            if (live) radio.stop();
            else listen();
          }}
        >
          <div className="field field-host">
            <label htmlFor="host">Receiver</label>
            <input
              id="host"
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                setFromList(false);
                setSecure(false);
              }}
              onBlur={normalizeReceiver}
              placeholder="kiwi hostname"
              autoComplete="off"
              spellCheck={false}
              disabled={live}
              required
            />
          </div>
          <div className="field field-port">
            <label htmlFor="port">Port</label>
            <input
              id="port"
              value={port}
              onChange={(e) => {
                setPort(e.target.value.replace(/\D/g, ""));
                setFromList(false);
              }}
              inputMode="numeric"
              disabled={live}
            />
          </div>
          <button type="submit" className={live ? "power power-on" : "power"}>
            {live ? "Stop" : "Listen"}
          </button>
        </form>
      </header>

      <Dial freqKhz={freqKhz} onChange={onDial} />

      <section className="controls" aria-label="Tuning">
        <FrequencyReadout freqKhz={freqKhz} onChange={(k) => changeFreq(k)} />

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

      <div className="status" role="status" data-state={status.state}>
        <span className="status-lamp" aria-hidden="true" />
        <span className="status-state">{STATE_TEXT[status.state]}</span>
        {status.state === "listening" && status.host && <span className="status-detail">on {status.host}</span>}
        {status.message && <span className="status-message">{status.message}</span>}
        {previous && !(current?.host === previous.host && current.port === previous.port) && (
          <button
            type="button"
            className="link-button status-back"
            onClick={() => switchTo(previous, previous.fromList)}
          >
            Back to {previous.label}
          </button>
        )}
      </div>

      <ReceiverPicker
        freqKhz={freqKhz}
        current={current}
        sun={sun}
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        onChoose={chooseReceiver}
        onPickBest={pickBest.start}
        picking={pickBest.running}
        onStopPicking={stopPicking}
        note={pickBest.note}
      >
        <p className="receiver-help">
          Let skywave pick a receiver, choose one from the list, or paste any address from{" "}
          <a href="http://kiwisdr.com/public/" target="_blank" rel="noreferrer">
            kiwisdr.com/public
          </a>
          . They're run by volunteers and most allow only a handful of listeners, so stop when you're done.
        </p>
      </ReceiverPicker>

      <Waterfall
        mode={mode}
        sampleRate={status.sampleRate ?? 12000}
        active={status.state === "listening"}
        subscribe={radio.onSpectrum}
        onClickOffset={onWaterfallClick}
      />

      <Presets freqKhz={freqKhz} mode={mode} onSelect={(p) => changeFreq(p.freqKhz, p.mode)} />
    </main>
  );
}
