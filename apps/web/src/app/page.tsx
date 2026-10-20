"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dial } from "@/components/Dial";
import { FrequencyReadout } from "@/components/FrequencyReadout";
import { Presets } from "@/components/Presets";
import { ReceiverPicker } from "@/components/ReceiverPicker";
import { SMeter } from "@/components/SMeter";
import { Waterfall } from "@/components/Waterfall";
import { covers, type Receiver } from "@/lib/kiwi-list";
import { MODE_LABELS, MODES, guessMode, type Mode } from "@/lib/radio-types";
import { DEFAULT_KIWI_PORT, parseReceiver } from "@/lib/receiver";
import { usePickBest } from "@/lib/use-pick-best";
import { useRadio } from "@/lib/use-radio";

const STORAGE_KEY = "skywave.receiver";
const CW_PITCH_KHZ = 0.7;

/** `fromList` marks a receiver from the public list, which the service dials public-only. */
type Saved = { host: string; port: string; fromList?: boolean };

function loadReceiver(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage unavailable; fall through */
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

function listSource(fromList: boolean) {
  return fromList ? { source: "list" as const } : {};
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
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_KIWI_PORT));
  // Whether host/port came from the public list. Typing in either field clears it.
  const [fromList, setFromList] = useState(false);
  const [freqKhz, setFreqKhz] = useState(10_000);
  const [mode, setMode] = useState<Mode>("am");
  const [volume, setVolume] = useState(0.8);
  const [browseOpen, setBrowseOpen] = useState(false);

  useEffect(() => {
    const r = loadReceiver();
    setHost(r.host);
    setPort(r.port);
    setFromList(r.fromList === true);
    // First visit: show the list so there's something to pick from.
    setBrowseOpen(!r.host);
  }, []);

  const live = status.state === "listening" || status.state === "connecting";
  const liveRef = useRef(live);
  liveRef.current = live;

  // Coalesce rapid dial drags into at most ~8 retunes a second.
  const pending = useRef<{ freqKhz: number; mode: Mode } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tuning = useRef({ host, port, fromList });
  tuning.current = { host, port, fromList };

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
    const r = { host: parsed.host, port: parsed.port ?? (port.trim() || String(DEFAULT_KIWI_PORT)) };
    setHost(r.host);
    setPort(r.port);
    return r;
  };

  const listen = () => {
    const r = normalizeReceiver();
    void tune({ host: r.host, port: Number(r.port), freqKhz, mode, ...listSource(fromList) });
  };

  // Stable so Pick best's retry effect doesn't re-run on every frequency change.
  const latest = useRef({ freqKhz, mode });
  latest.current = { freqKhz, mode };
  const tuneReceiver = useCallback(
    (r: Receiver, fromList: boolean) => {
      // A dial retune still waiting on its timer would otherwise go to the old
      // receiver after this tune and switch the service back.
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
      tuning.current = { host: r.host, port: String(r.port), fromList };
      setHost(r.host);
      setPort(String(r.port));
      setFromList(fromList);
      // Works while listening too: the radio service switches receivers.
      void tune({ host: r.host, port: r.port, ...latest.current, ...listSource(fromList) });
    },
    [tune],
  );
  // The dial can move during a run; only try receivers that still cover it.
  const coversDial = useCallback((r: Receiver) => covers(r, latest.current.freqKhz), []);
  const wasListed = useCallback((h: string, p: number) => {
    const t = tuning.current;
    return t.fromList && t.host === h && Number(t.port) === p;
  }, []);
  const pickBest = usePickBest(status, tuneReceiver, coversDial, wasListed);
  const { cancel: cancelPickBest, stop: stopPickBest } = pickBest;
  // With nothing to go back to, stop the attempt that's still connecting too.
  const stopPicking = useCallback(() => {
    if (!stopPickBest()) radio.stop();
  }, [stopPickBest, radio]);
  const chooseReceiver = useCallback(
    (r: Receiver) => {
      cancelPickBest();
      tuneReceiver(r, true);
    },
    [cancelPickBest, tuneReceiver],
  );
  const portNumber = Number(port) || DEFAULT_KIWI_PORT;
  const current = useMemo(() => ({ host, port: portNumber }), [host, portNumber]);

  // Remember a receiver only once it actually plays, so a typo or a failed
  // Pick best run never becomes the saved default.
  useEffect(() => {
    if (status.state === "listening" && status.host) {
      const port = String(status.port ?? DEFAULT_KIWI_PORT);
      saveReceiver({ host: status.host, port, ...(wasListed(status.host, Number(port)) && { fromList: true }) });
    }
  }, [status, wasListed]);

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

      <p className="receiver-help">
        Let skywave pick a receiver, choose one from the list, or paste any address from{" "}
        <a href="http://kiwisdr.com/public/" target="_blank" rel="noreferrer">
          kiwisdr.com/public
        </a>
        . They're run by volunteers and most allow only a handful of listeners, so stop when you're done.
      </p>

      <ReceiverPicker
        freqKhz={freqKhz}
        current={current}
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        onChoose={chooseReceiver}
        onPickBest={pickBest.start}
        picking={pickBest.running}
        onStopPicking={stopPicking}
        note={pickBest.note}
      />

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
      </div>

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
