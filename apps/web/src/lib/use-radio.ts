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

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const rateRef = useRef(DEFAULT_RATE);
  const volumeRef = useRef(0.8);
  const listenersRef = useRef(new Set<SpectrumListener>());
  const stoppingRef = useRef(false);
  // Whether this socket already warned about a frame tag we don't know.
  const warnedTagRef = useRef(false);
  // Bumped by every tune and stop, so a tune still waiting on audio or the
  // socket can tell it was superseded and must not send.
  const generationRef = useRef(0);

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

  const handleText = useCallback((raw: string) => {
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
      if (state !== "listening") setMeter(null);
      setStatus({
        state,
        message: typeof msg.message === "string" ? msg.message : undefined,
        // An unknown code would read as "X undefined" in Pick best's note; treat
        // it as uncoded, which stops Pick best like any service-side error.
        code: typeof msg.code === "string" && KNOWN_CODES.has(msg.code) ? (msg.code as RadioErrorCode) : undefined,
        retryAfterMs:
          typeof msg.retryAfterMs === "number" && msg.retryAfterMs > 0 ? msg.retryAfterMs : undefined,
        sampleRate,
        host: typeof msg.host === "string" ? msg.host : undefined,
        port: typeof msg.port === "number" ? msg.port : undefined,
      });
    } else if (msg.type === "meter") {
      setMeter({ rssi: Number(msg.rssi), overflow: Boolean(msg.overflow) });
    }
  }, []);

  const handleBinary = useCallback((buf: ArrayBuffer) => {
    const tag = new Uint8Array(buf, 0, 1)[0];
    let audio: Float32Array | null = null;
    let row: Float32Array | null = null;
    // Typed arrays need their element alignment, so copy past the 1-byte tag.
    if (tag === AUDIO_TAG) {
      // The usual int16 scale: the service sends at most 32767, so this stays in [-1, 1].
      audio = Float32Array.from(new Int16Array(buf.slice(1)), (v) => v / 32768);
    } else if (tag === SPECTRUM_TAG) {
      const base = new Float32Array(buf.slice(1, 5))[0]!;
      row = Float32Array.from(new Uint8Array(buf, 5), (v) => base + v * SPECTRUM_STEP_DB);
    } else if (tag === AUDIO_F32_TAG) {
      audio = new Float32Array(buf.slice(1));
    } else if (tag === SPECTRUM_F32_TAG) {
      row = new Float32Array(buf.slice(1));
    } else if (!warnedTagRef.current) {
      // Otherwise sound and waterfall just stop while the status says listening.
      warnedTagRef.current = true;
      console.warn(`The radio service sent frame type ${tag}, which this page doesn't know. Try reloading.`);
    }
    if (audio) nodeRef.current?.port.postMessage({ type: "samples", data: audio }, [audio.buffer]);
    if (row) for (const fn of listenersRef.current) fn(row, rateRef.current);
  }, []);

  const ensureSocket = useCallback((): Promise<WebSocket> => {
    const existing = wsRef.current;
    if (existing && existing.readyState === WebSocket.OPEN) return Promise.resolve(existing);
    if (existing && existing.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        existing.addEventListener("open", () => resolve(existing), { once: true });
        existing.addEventListener("error", () => reject(new Error("socket")), { once: true });
      });
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(serviceUrl());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      stoppingRef.current = false;
      warnedTagRef.current = false;
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("socket"));
      ws.onmessage = (e) => {
        // A closing socket can still deliver a status that's no longer true.
        if (wsRef.current !== ws) return;
        if (typeof e.data === "string") handleText(e.data);
        else handleBinary(e.data as ArrayBuffer);
      };
      ws.onclose = () => {
        // Only the live socket may touch audio and status. After Stop and a
        // quick Listen, the old socket's close arrives while a new one plays.
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        nodeRef.current?.port.postMessage({ type: "reset" });
        setMeter(null);
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
  }, [handleBinary, handleText]);

  /** Start listening, or retune if already connected. Call from a click so audio can start. */
  const tune = useCallback(
    async (t: Tuning) => {
      const generation = ++generationRef.current;
      try {
        await ensureAudio();
      } catch {
        if (generation !== generationRef.current) return;
        setStatus({ state: "error", message: "This browser blocked audio. Click Listen again." });
        return;
      }
      if (generation !== generationRef.current) return;
      let ws: WebSocket;
      try {
        ws = await ensureSocket();
      } catch {
        if (generation !== generationRef.current) return;
        setStatus({
          state: "error",
          message: `Can't reach the radio service at ${SERVICE_URL}. Start it with pnpm dev:radio.`,
        });
        return;
      }
      if (generation !== generationRef.current) return;
      ws.send(JSON.stringify({ type: "tune", ...t }));
    },
    [ensureAudio, ensureSocket],
  );

  /** Retune only if already listening; never opens a connection on its own. */
  const retune = useCallback((t: Tuning) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "tune", ...t }));
  }, []);

  const stop = useCallback(() => {
    generationRef.current++;
    stoppingRef.current = true;
    const ws = wsRef.current;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
      ws.close();
      wsRef.current = null;
    }
    nodeRef.current?.port.postMessage({ type: "reset" });
    setMeter(null);
    setStatus({ state: "idle" });
  }, []);

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

  return { status, meter, tune, retune, stop, setVolume, onSpectrum };
}
