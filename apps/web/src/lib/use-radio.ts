"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Mode } from "./radio-types";

export type RadioState = "idle" | "connecting" | "listening" | "stopped" | "error";

export type Tuning = {
  host: string;
  port: number;
  freqKhz: number;
  mode: Mode;
  /** "list" for a receiver taken from the public list, which the service dials on public addresses only. */
  source?: "list";
  /** The receiver serves https only; the service dials it over wss://. */
  secure?: true;
};

/**
 * Every `code` the radio service puts on an error status: KiwiError codes
 * (apps/radio/skywave_radio/kiwi.py) and HostRejected codes (hostguard.py).
 * apps/radio/tests/test_error_codes.py fails if the two sides drift.
 */
export const RADIO_ERROR_CODES = [
  "busy",
  "no_apps",
  "down",
  "unreachable",
  "timeout",
  "password",
  "redirect",
  "bad_rate",
  "closed",
  "invalid",
  "dns",
  "blocked",
] as const;

export type RadioErrorCode = (typeof RADIO_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(RADIO_ERROR_CODES);
// How long a new connection to the radio service may take to open.
const CONNECT_TIMEOUT_MS = 10_000;
// The service closes a socket left idle (nothing playing, no messages) with
// this code. It's a quiet hang-up, not an outage: the next tune reconnects.
// Keep in step with IDLE_CLOSE_CODE in apps/radio/skywave_radio/server.py.
export const IDLE_CLOSE_CODE = 4000;
// The service refuses a socket when this browser's address already holds too
// many. Keep in step with TOO_MANY_SOCKETS_CODE in apps/radio/skywave_radio/server.py.
export const TOO_MANY_SOCKETS_CODE = 4001;

export type RadioStatus = {
  state: RadioState;
  message?: string;
  /**
   * Why an error happened. Errors from our side (listener limit, bad request)
   * have none, and neither do codes from a newer radio service than this build.
   */
  code?: RadioErrorCode;
  /** On an uncoded error: the same receiver may work if tried again after this long. */
  retryAfterMs?: number;
  sampleRate?: number;
  host?: string;
  port?: number;
};

export type Meter = { rssi: number; overflow: boolean };

/** One strong broadcast signal from a band scan. */
export type ScanSignal = { freqKhz: number; snrDb: number; band: string };

/**
 * The band scan of the receiver being listened to (apps/radio's session.py,
 * "scan" messages). Only the newest request's reply for that receiver lands.
 */
export type ScanState =
  | { state: "scanning"; host: string; port: number }
  | {
      state: "done";
      host: string;
      port: number;
      signals: ScanSignal[];
      /** Flat-topped signals (digital, jamming) left out of the list. */
      hidden: number;
      bandsDone: number;
      bandsTotal: number;
      /** Only some bands were scanned (the receiver was slow or stalled); not cached by the service. */
      partial: boolean;
    }
  | { state: "error"; host: string; port: number; message: string };

type SpectrumListener = (row: Float32Array, sampleRate: number) => void;

// Frame tags: 3 is int16 audio, 4 is a float32 base dB then a uint8 per bin.
// 1 and 2 (float32 audio and dB) are what a radio service from before the
// switch sends; reading them lets the web app deploy first.
const AUDIO_TAG = 3;
const SPECTRUM_TAG = 4;
const AUDIO_F32_TAG = 1;
const SPECTRUM_F32_TAG = 2;
// Must match SPECTRUM_STEP_DB in apps/radio/skywave_radio/dsp.py.
const SPECTRUM_STEP_DB = 0.5;
// Must match Spectrum's bins in apps/radio/skywave_radio/dsp.py. A row of any
// other length is skipped: the waterfall sizes its canvas to the row.
const SPECTRUM_BINS = 512;
// The radio service takes Kiwi frames up to MAX_FRAME_BYTES (1 MiB) in
// apps/radio/skywave_radio/kiwi.py, at most 2**18 samples each, and sends each
// as one audio frame. Keep this at least that; bigger frames are skipped.
const MAX_AUDIO_SAMPLES = 2 ** 18;
// Real rows sit around -200 to +60 dB. A value past this (or NaN) would drag
// the waterfall's running floor for minutes, so its row is skipped.
const MAX_ABS_DB = 300;
const DEFAULT_RATE = 12000;
const SERVICE_URL = process.env.NEXT_PUBLIC_RADIO_WS_URL ?? "ws://localhost:8765/ws";

function serviceUrl() {
  const token = process.env.NEXT_PUBLIC_RADIO_TOKEN;
  return token ? `${SERVICE_URL}?token=${encodeURIComponent(token)}` : SERVICE_URL;
}

/**
 * Owns the WebSocket to the radio service and the Web Audio graph.
 * Audio and spectrum frames bypass React state entirely; only status and
 * the S-meter re-render.
 */
export function useRadio() {
  const [status, setStatus] = useState<RadioStatus>({ state: "idle" });
  const [meter, setMeter] = useState<Meter | null>(null);
  // A tune is waiting on audio, the socket or the service's first answer. The
  // status alone can't say so: it stays as it was until the service replies.
  const [tuning, setTuning] = useState(false);
  // Sound has arrived since the latest tune: what "it's playing" really means.
  // Per tune, so it drops on every switch; anything that should stay once
  // sound has played (the map, once mounted) must latch it.
  const [heardAudio, setHeardAudio] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const rateRef = useRef(DEFAULT_RATE);
  const volumeRef = useRef(0.8);
  const listenersRef = useRef(new Set<SpectrumListener>());
  const stoppingRef = useRef(false);
  // Whether this socket already warned about a frame we can't read.
  const warnedFrameRef = useRef(false);
  // Bumped by every tune and stop, so a tune still waiting on audio or the
  // socket can tell it was superseded and must not send.
  const generationRef = useRef(0);
  // Mirrors tuning for the frame handler. Audio still in flight from the last
  // receiver arrives before the service answers a tune; it doesn't count.
  const tuningRef = useRef(false);
  const heardAudioRef = useRef(false);
  // The tune in progress: which receiver an answer must name to end it (a
  // dial retune on the last receiver can still be answered after a switch).
  const pendingRef = useRef<Tuning | null>(null);
  // What the tune in progress will send: its own tuning, then any dial move
  // for the same receiver made while audio or the socket start. Unlike
  // pendingRef, a dropped socket doesn't clear it (the tune still goes out on
  // a new socket and must carry the newest dial); only tune and stop do.
  const latestRef = useRef<Tuning | null>(null);
  // tune(), for a socket's close handler that must send a tune again.
  const retryTuneRef = useRef<((t: Tuning) => Promise<void>) | null>(null);
  // The socket a dial move for the tune in progress already went out on: on
  // that socket the service has the newer tuning, and the tune's own send
  // would undo it. (A fresh socket has had nothing, so the tune must go.)
  const retunedRef = useRef<WebSocket | null>(null);
  // Band scan. canScan: the service said it can ("features" on its statuses);
  // an older one would answer a scan request with an error status.
  const [canScan, setCanScan] = useState(false);
  const [scan, setScan] = useState<ScanState | null>(null);
  // The receiver being listened to, for scan requests and replies.
  const listeningRef = useRef<{ host: string; port: number } | null>(null);
  // The newest scan request; replies for any other are late and ignored.
  const scanRef = useRef<{ id: number; host: string; port: number } | null>(null);
  const scanIdRef = useRef(0);
  const clearScan = useCallback(() => {
    scanRef.current = null;
    setScan(null);
  }, []);

  const setTuningBoth = useCallback((v: boolean) => {
    tuningRef.current = v;
    if (!v) pendingRef.current = null;
    setTuning(v);
  }, []);
  const setHeardAudioBoth = useCallback((v: boolean) => {
    heardAudioRef.current = v;
    setHeardAudio(v);
  }, []);

  const ensureAudio = useCallback(async () => {
    if (ctxRef.current) {
      await ctxRef.current.resume();
      return;
    }
    let ctx: AudioContext;
    try {
      // Running the context at the radio's rate lets the browser do the
      // high-quality resampling to the sound card.
      ctx = new AudioContext({ sampleRate: DEFAULT_RATE, latencyHint: "playback" });
    } catch {
      ctx = new AudioContext({ latencyHint: "playback" });
    }
    await ctx.audioWorklet.addModule("/worklets/radio-player.js");
    const node = new AudioWorkletNode(ctx, "radio-player", { numberOfInputs: 0, outputChannelCount: [1] });
    const gain = ctx.createGain();
    gain.gain.value = volumeRef.current;
    node.connect(gain).connect(ctx.destination);
    node.port.postMessage({ type: "rate", rate: rateRef.current });
    ctxRef.current = ctx;
    nodeRef.current = node;
    gainRef.current = gain;
    await ctx.resume();
  }, []);

  const handleText = useCallback(
    (raw: string) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === "status") {
        const sampleRate = typeof msg.sampleRate === "number" ? msg.sampleRate : undefined;
        if (sampleRate && Math.abs(sampleRate - rateRef.current) > 0.5) {
          rateRef.current = sampleRate;
          nodeRef.current?.port.postMessage({ type: "rate", rate: sampleRate });
        }
        const state = msg.state as RadioState;
        const host = typeof msg.host === "string" ? msg.host : undefined;
        const port = typeof msg.port === "number" ? msg.port : undefined;
        const pending = pendingRef.current;
        // An unknown code would read as "X undefined" in Pick best's note; treat
        // it as uncoded, which stops Pick best like any service-side error.
        const code =
          typeof msg.code === "string" && KNOWN_CODES.has(msg.code) ? (msg.code as RadioErrorCode) : undefined;
        // A tune the service rejects outright (an uncoded error) still names the
        // old receiver, and does end it. A coded error naming the old receiver is
        // that receiver dropping as we leave it; the new tune is still coming.
        const rejected = state === "error" && !code;
        const forAnother =
          pending !== null &&
          !rejected &&
          host !== undefined &&
          (host.toLowerCase() !== pending.host.toLowerCase() || (port !== undefined && port !== pending.port));
        if (!forAnother) setTuningBoth(false);
        if (state !== "listening") {
          setMeter(null);
          setHeardAudioBoth(false);
        }
        setCanScan(Array.isArray(msg.features) && msg.features.includes("scan"));
        listeningRef.current =
          state === "listening" && host !== undefined && port !== undefined ? { host, port } : null;
        // The service drops a scan when its receiver connection ends, without a
        // reply. Clear ours too, or a reconnect to the same receiver would keep
        // "Scanning…" (or an old list) and never scan again.
        const asked = scanRef.current;
        if (asked && (state !== "listening" || host !== asked.host || port !== asked.port)) clearScan();
        setStatus({
          state,
          message: typeof msg.message === "string" ? msg.message : undefined,
          code,
          retryAfterMs: typeof msg.retryAfterMs === "number" && msg.retryAfterMs > 0 ? msg.retryAfterMs : undefined,
          sampleRate,
          host,
          port,
        });
      } else if (msg.type === "meter") {
        setMeter({ rssi: Number(msg.rssi), overflow: Boolean(msg.overflow) });
      } else if (msg.type === "scan") {
        const asked = scanRef.current;
        // A reply for an older request or another receiver arrives after a
        // switch or Scan again; it must not fill the current list.
        if (!asked || msg.id !== asked.id || msg.host !== asked.host || msg.port !== asked.port) return;
        const { host, port } = asked;
        if (msg.state === "scanning") setScan({ state: "scanning", host, port });
        else if (msg.state === "done" && Array.isArray(msg.signals)) {
          setScan({
            state: "done",
            host,
            port,
            signals: msg.signals.filter(
              (s): s is ScanSignal =>
                typeof s?.freqKhz === "number" && typeof s?.snrDb === "number" && typeof s?.band === "string",
            ),
            hidden: typeof msg.hidden === "number" ? msg.hidden : 0,
            bandsDone: Number(msg.bandsDone) || 0,
            bandsTotal: Number(msg.bandsTotal) || 0,
            partial: msg.partial === true,
          });
        } else if (msg.state === "error") {
          const message = typeof msg.message === "string" ? msg.message : "Couldn't scan this receiver.";
          setScan({ state: "error", host, port, message });
        }
      }
    },
    [setTuningBoth, setHeardAudioBoth, clearScan],
  );

  const handleBinary = useCallback(
    (buf: ArrayBuffer) => {
      const tag = new Uint8Array(buf)[0]; // undefined for an empty frame, which is skipped
      const size = buf.byteLength - 1;
      let audio: Float32Array | null = null;
      let row: Float32Array | null = null;
      // Typed arrays need their element alignment, so copy past the 1-byte tag.
      // A frame that doesn't fit its tag (empty, misaligned, audio over
      // MAX_AUDIO_SAMPLES, a row that isn't SPECTRUM_BINS long) falls through.
      if (tag === AUDIO_TAG && size > 0 && size % 2 === 0 && size / 2 <= MAX_AUDIO_SAMPLES) {
        // The usual int16 scale: the service sends at most 32767, so this stays in [-1, 1].
        audio = Float32Array.from(new Int16Array(buf.slice(1)), (v) => v / 32768);
      } else if (tag === SPECTRUM_TAG && size === 4 + SPECTRUM_BINS) {
        const base = new Float32Array(buf.slice(1, 5))[0]!;
        row = Float32Array.from(new Uint8Array(buf, 5), (v) => base + v * SPECTRUM_STEP_DB);
      } else if (tag === AUDIO_F32_TAG && size > 0 && size % 4 === 0 && size / 4 <= MAX_AUDIO_SAMPLES) {
        audio = new Float32Array(buf.slice(1));
      } else if (tag === SPECTRUM_F32_TAG && size === 4 * SPECTRUM_BINS) {
        row = new Float32Array(buf.slice(1));
      }
      // A row with a value past MAX_ABS_DB is skipped too; NaN fails the check.
      if (row && !row.every((v) => Math.abs(v) <= MAX_ABS_DB)) row = null;
      if (!audio && !row && !warnedFrameRef.current) {
        // Otherwise sound and waterfall just stop while the status says listening.
        warnedFrameRef.current = true;
        const what =
          buf.byteLength === 0 ? "an empty frame" : `a frame this page can't read (type ${tag}, ${size} bytes)`;
        console.warn(`The radio service sent ${what}. Try reloading.`);
      }
      if (audio) {
        nodeRef.current?.port.postMessage({ type: "samples", data: audio }, [audio.buffer]);
        if (!heardAudioRef.current && !tuningRef.current) setHeardAudioBoth(true);
      }
      if (row) for (const fn of listenersRef.current) fn(row, rateRef.current);
    },
    [setHeardAudioBoth],
  );

  const ensureSocket = useCallback((): Promise<WebSocket> => {
    const existing = wsRef.current;
    if (existing && existing.readyState === WebSocket.OPEN) return Promise.resolve(existing);
    if (existing && existing.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        existing.addEventListener("open", () => resolve(existing), { once: true });
        existing.addEventListener("error", () => reject(new Error("socket")), { once: true });
        // The connect timeout closes it; don't rely on the browser firing error first.
        existing.addEventListener("close", () => reject(new Error("socket")), { once: true });
      });
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(serviceUrl());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      stoppingRef.current = false;
      warnedFrameRef.current = false;
      // A service behind an address that drops packets never answers; don't
      // leave the page connecting until the browser gives up.
      const timer = setTimeout(() => {
        if (ws.readyState !== WebSocket.CONNECTING) return;
        if (wsRef.current === ws) wsRef.current = null;
        ws.close();
        reject(new Error("timeout"));
      }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("socket"));
      };
      ws.onmessage = (e) => {
        // A closing socket can still deliver a status that's no longer true.
        if (wsRef.current !== ws) return;
        if (typeof e.data === "string") handleText(e.data);
        else handleBinary(e.data as ArrayBuffer);
      };
      ws.onclose = (event) => {
        // Only the live socket may touch audio and status. After Stop and a
        // quick Listen, the old socket's close arrives while a new one plays.
        if (wsRef.current !== ws) return;
        // A Listen that crossed an idle hang-up in flight: send it again below.
        const crossed = event.code === IDLE_CLOSE_CODE && tuningRef.current ? latestRef.current : null;
        wsRef.current = null;
        nodeRef.current?.port.postMessage({ type: "reset" });
        listeningRef.current = null;
        setCanScan(false);
        clearScan();
        setMeter(null);
        setTuningBoth(false);
        setHeardAudioBoth(false);
        // Hung up for being idle: nothing was playing, so the status stands.
        if (event.code === IDLE_CLOSE_CODE) {
          if (crossed && !stoppingRef.current) void retryTuneRef.current?.(crossed);
          return;
        }
        if (event.code === TOO_MANY_SOCKETS_CODE) {
          setStatus({
            state: "error",
            message:
              "Too many radio connections are open from your network (your other tabs, or others sharing it). Close a skywave tab, or try again later.",
          });
          return;
        }
        if (!stoppingRef.current) {
          // Always a fresh, uncoded error: anything waiting on this socket
          // (Pick best's retries) must see that nothing more is coming.
          setStatus((s) => ({
            state: "error",
            // Keep a receiver's own explanation ("needs a password"); it's
            // still true. But say the service went too, or nobody learns it's down.
            message:
              s.state === "error" && s.message
                ? `${s.message} The connection to the radio service was lost too.`
                : "Lost the connection to the radio service. Is it running?",
          }));
        }
      };
    });
  }, [handleBinary, handleText, setTuningBoth, setHeardAudioBoth, clearScan]);

  /** Start listening, or retune if already connected. Call from a click so audio can start. */
  const tune = useCallback(
    async (t: Tuning) => {
      const generation = ++generationRef.current;
      pendingRef.current = t;
      latestRef.current = t;
      retunedRef.current = null;
      const asked = scanRef.current;
      if (asked && (asked.host !== t.host || asked.port !== t.port)) clearScan();
      setTuningBoth(true);
      setHeardAudioBoth(false);
      try {
        await ensureAudio();
      } catch {
        if (generation !== generationRef.current) return;
        setTuningBoth(false);
        setStatus({ state: "error", message: "This browser blocked audio. Click Listen again." });
        return;
      }
      if (generation !== generationRef.current) return;
      let ws: WebSocket;
      try {
        ws = await ensureSocket();
      } catch {
        if (generation !== generationRef.current) return;
        setTuningBoth(false);
        setStatus({
          state: "error",
          message: `Can't reach the radio service at ${SERVICE_URL}. Start it with pnpm dev:radio.`,
        });
        return;
      }
      if (generation !== generationRef.current) return;
      // A dial move while audio woke already went out for this receiver; sending now would undo it.
      if (retunedRef.current === ws) return;
      ws.send(JSON.stringify({ type: "tune", ...(latestRef.current ?? t) }));
    },
    [ensureAudio, ensureSocket, setTuningBoth, setHeardAudioBoth, clearScan],
  );
  useEffect(() => {
    retryTuneRef.current = tune;
  }, [tune]);

  /**
   * Retune the receiver being listened to or tuned; never opens a connection
   * on its own. A tune still starting sends this instead of what it began with.
   */
  const retune = useCallback((t: Tuning) => {
    const pending = pendingRef.current;
    const forPending = !!pending && pending.host === t.host && pending.port === t.port;
    if (forPending) {
      pendingRef.current = t;
      latestRef.current = t;
    }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "tune", ...t }));
      if (forPending) retunedRef.current = ws;
    }
  }, []);

  const stop = useCallback(() => {
    generationRef.current++;
    stoppingRef.current = true;
    latestRef.current = null;
    const ws = wsRef.current;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
      ws.close();
      wsRef.current = null;
    }
    nodeRef.current?.port.postMessage({ type: "reset" });
    listeningRef.current = null;
    clearScan();
    setMeter(null);
    setTuningBoth(false);
    setHeardAudioBoth(false);
    setStatus({ state: "idle" });
  }, [setTuningBoth, setHeardAudioBoth, clearScan]);

  /**
   * Scan the receiver being listened to for strong broadcast signals. `fresh`
   * skips the service's 10-minute cache. Does nothing unless the service
   * supports it and a receiver is playing.
   */
  const startScan = useCallback(
    (fresh = false) => {
      const ws = wsRef.current;
      const playing = listeningRef.current;
      if (!canScan || !playing || !ws || ws.readyState !== WebSocket.OPEN) return;
      const id = ++scanIdRef.current;
      scanRef.current = { id, ...playing };
      setScan({ state: "scanning", ...playing });
      ws.send(JSON.stringify({ type: "scan", id, fresh }));
    },
    [canScan],
  );

  const setVolume = useCallback((v: number) => {
    volumeRef.current = v;
    const gain = gainRef.current;
    if (gain && ctxRef.current) gain.gain.setTargetAtTime(v, ctxRef.current.currentTime, 0.02);
  }, []);

  const onSpectrum = useCallback((fn: SpectrumListener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  useEffect(
    () => () => {
      stoppingRef.current = true;
      wsRef.current?.close();
      void ctxRef.current?.close();
    },
    [],
  );

  return {
    status,
    meter,
    tuning,
    heardAudio,
    canScan,
    scan,
    tune,
    retune,
    stop,
    startScan,
    setVolume,
    onSpectrum,
  };
}
