"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Mode } from "./radio-types";

export type RadioState = "idle" | "connecting" | "listening" | "stopped" | "error";

export type Tuning = { host: string; port: number; freqKhz: number; mode: Mode };

export type RadioStatus = {
  state: RadioState;
  message?: string;
  sampleRate?: number;
  host?: string;
};

export type Meter = { rssi: number; overflow: boolean };

type SpectrumListener = (row: Float32Array, sampleRate: number) => void;

const AUDIO_TAG = 1;
const SPECTRUM_TAG = 2;
const DEFAULT_RATE = 12000;

function serviceUrl() {
  const base = process.env.NEXT_PUBLIC_RADIO_WS_URL ?? "ws://localhost:8765/ws";
  const token = process.env.NEXT_PUBLIC_RADIO_TOKEN;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
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
        sampleRate,
        host: typeof msg.host === "string" ? msg.host : undefined,
      });
    } else if (msg.type === "meter") {
      setMeter({ rssi: Number(msg.rssi), overflow: Boolean(msg.overflow) });
    }
  }, []);

  const handleBinary = useCallback((buf: ArrayBuffer) => {
    const tag = new Uint8Array(buf, 0, 1)[0];
    // Float32Array needs 4-byte alignment, so copy past the 1-byte tag.
    const data = new Float32Array(buf.slice(1));
    if (tag === AUDIO_TAG) {
      nodeRef.current?.port.postMessage({ type: "samples", data }, [data.buffer]);
    } else if (tag === SPECTRUM_TAG) {
      for (const fn of listenersRef.current) fn(data, rateRef.current);
    }
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
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("socket"));
      ws.onmessage = (e) => (typeof e.data === "string" ? handleText(e.data) : handleBinary(e.data as ArrayBuffer));
      ws.onclose = () => {
        // Only the live socket may touch audio and status. After Stop and a
        // quick Listen, the old socket's close arrives while a new one plays.
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        nodeRef.current?.port.postMessage({ type: "reset" });
        setMeter(null);
        if (!stoppingRef.current) {
          setStatus((s) =>
            s.state === "error"
              ? s
              : { state: "error", message: "Lost the connection to the radio service. Is it running?" },
          );
        }
      };
    });
  }, [handleBinary, handleText]);

  /** Start listening, or retune if already connected. Call from a click so audio can start. */
  const tune = useCallback(
    async (t: Tuning) => {
      try {
        await ensureAudio();
      } catch {
        setStatus({ state: "error", message: "This browser blocked audio. Click Listen again." });
        return;
      }
      let ws: WebSocket;
      try {
        ws = await ensureSocket();
      } catch {
        setStatus({
          state: "error",
          message: `Can't reach the radio service at ${process.env.NEXT_PUBLIC_RADIO_WS_URL ?? "ws://localhost:8765/ws"}. Start it with pnpm dev:radio.`,
        });
        return;
      }
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
