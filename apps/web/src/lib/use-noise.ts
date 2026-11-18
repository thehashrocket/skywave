"use client";

import { useEffect, useMemo, useState } from "react";
import { rankReceivers, type Receiver } from "./kiwi-list";
import { NOISE_MAX_RECEIVERS, noiseBand, noiseKey, type NoiseLevels, type NoiseStat } from "./noise-rank";

const SERVICE_URL = process.env.NEXT_PUBLIC_RADIO_WS_URL ?? "ws://localhost:8765/ws";

/**
 * How often the levels are fetched again while the dial stays in one band:
 * the median is per UTC hour, and the service lets caches keep an answer
 * for 5 minutes.
 */
export const NOISE_REFRESH_MS = 10 * 60_000;

/** GET /noise on the radio service the WebSocket URL points at, or null if that URL doesn't parse. */
export function noiseUrl(wsUrl: string, keys: readonly string[], band: string): string | null {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return null;
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.replace(/\/ws\/?$/, "") + "/noise";
  url.search = new URLSearchParams({ receivers: keys.join(","), band }).toString();
  return url.toString();
}

function isStat(v: unknown): v is NoiseStat {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  return (
    (s.medianDb === null || num(s.medianDb)) &&
    num(s.count) &&
    (s.baselineDb === null || num(s.baselineDb)) &&
    num(s.baselineCount)
  );
}

/** The service's answer, keeping only well-formed rows; null if it isn't one. */
export function parseNoise(body: unknown): NoiseLevels | null {
  if (typeof body !== "object" || body === null) return null;
  const { band, receivers } = body as Record<string, unknown>;
  if (typeof band !== "string" || typeof receivers !== "object" || receivers === null) return null;
  const out: Record<string, NoiseStat> = {};
  for (const [key, stat] of Object.entries(receivers)) if (isStat(stat)) out[key] = stat;
  return { band, receivers: out };
}

/**
 * The noise levels for the band the dial is in, for the receivers Pick best
 * would consider there (the first NOISE_MAX_RECEIVERS by the list's rank).
 * Null until they arrive, outside the dial's bands, or when the service
 * can't say: Pick best then ranks by the list's SNR alone.
 */
export function useNoise(receivers: readonly Receiver[] | undefined, freqKhz: number): NoiseLevels | null {
  const range = noiseBand(freqKhz);
  const band = range?.id ?? null;
  // Candidates at the band's middle, so moving the dial within it asks nothing new.
  const mid = range ? (range.startKhz + range.endKhz) / 2 : 0;
  const keys = useMemo(
    () =>
      band && receivers
        ? rankReceivers(receivers, mid).slice(0, NOISE_MAX_RECEIVERS).map(noiseKey).sort().join(",")
        : "",
    [receivers, band, mid],
  );
  const [levels, setLevels] = useState<NoiseLevels | null>(null);
  useEffect(() => {
    if (!band || !keys) return;
    const url = noiseUrl(SERVICE_URL, keys.split(","), band);
    if (!url) return;
    let abort: AbortController | null = null;
    const load = () => {
      abort?.abort();
      const mine = (abort = new AbortController());
      fetch(url, { signal: mine.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (mine.signal.aborted) return;
          const parsed = parseNoise(body);
          // An answer for another band is no answer.
          if (parsed && parsed.band === band) setLevels(parsed);
        })
        .catch(() => {
          // The service is down, older (no /noise), or blocked: SNR alone it is.
        });
    };
    load();
    const timer = setInterval(load, NOISE_REFRESH_MS);
    return () => {
      clearInterval(timer);
      abort?.abort();
    };
  }, [band, keys]);
  return levels;
}
