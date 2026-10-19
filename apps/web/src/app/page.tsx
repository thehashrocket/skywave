"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dial } from "@/components/Dial";
import { FrequencyReadout } from "@/components/FrequencyReadout";
import { Presets } from "@/components/Presets";
import { SMeter } from "@/components/SMeter";
import { Waterfall } from "@/components/Waterfall";
import { MODE_LABELS, MODES, guessMode, type Mode } from "@/lib/radio-types";
import { parseReceiver } from "@/lib/receiver";
import { useRadio } from "@/lib/use-radio";

const STORAGE_KEY = "skywave.receiver";
const CW_PITCH_KHZ = 0.7;

function loadReceiver(): { host: string; port: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage unavailable; fall through */
  }
  return { host: "", port: "8073" };
}

function saveReceiver(r: { host: string; port: string }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
  } catch {
    /* ignore */
  }
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
  const { status, meter } = radio;
  const [host, setHost] = useState("");
  const [port, setPort] = useState("8073");
  const [freqKhz, setFreqKhz] = useState(10_000);
  const [mode, setMode] = useState<Mode>("am");
  const [volume, setVolume] = useState(0.8);

  useEffect(() => {
    const r = loadReceiver();
    setHost(r.host);
    setPort(r.port);
  }, []);

  const live = status.state === "listening" || status.state === "connecting";

  // Coalesce rapid dial drags into at most ~8 retunes a second.
  const pending = useRef<{ freqKhz: number; mode: Mode } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tuning = useRef({ host, port });
  tuning.current = { host, port };

  const sendRetune = useCallback(
    (next: { freqKhz: number; mode: Mode }) => {
      if (!live) return;
      pending.current = next;
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const p = pending.current;
        if (!p) return;
        radio.retune({ host: tuning.current.host.trim(), port: Number(tuning.current.port) || 8073, ...p });
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
    const r = { host: parsed.host, port: parsed.port ?? (port.trim() || "8073") };
    setHost(r.host);
    setPort(r.port);
    return r;
  };

  const listen = () => {
    const r = normalizeReceiver();
    saveReceiver(r);
    void radio.tune({ host: r.host, port: Number(r.port), freqKhz, mode });
  };

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
            if (live) radio.stop();
            else listen();
          }}
        >
          <div className="field field-host">
            <label htmlFor="host">Receiver</label>
            <input
              id="host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
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
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
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
        Pick any public receiver from{" "}
        <a href="http://kiwisdr.com/public/" target="_blank" rel="noreferrer">
          kiwisdr.com/public
        </a>{" "}
        and paste its address. They're run by volunteers and most allow only a handful of listeners, so stop when you're
        done.
      </p>

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
