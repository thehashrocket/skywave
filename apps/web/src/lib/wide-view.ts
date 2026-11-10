import { BROADCAST_BANDS, HAM_BANDS, type Band } from "./radio-types";

/**
 * The receiver's own waterfall, beside the audio one: how wide it looks and
 * where. The radio service streams it ("view" in apps/radio's session.py) as
 * a Kiwi zoom and an RF centre; each frame says where it really landed.
 */

/** What most Kiwis cover, so what a zoom spans; a frame carries the real span. */
export const KIWI_SPAN_KHZ = 30_000;
const MAX_ZOOM = 14;

/** The waterfall's widths: the audio passband, three Kiwi zooms, and the band the dial is in. */
export type SpanStep = "audio" | "15" | "60" | "230" | "band";
export const SPAN_STEPS: readonly SpanStep[] = ["audio", "15", "60", "230", "band"];
export const DEFAULT_SPAN: SpanStep = "60";
const ZOOMS: Record<"15" | "60" | "230", number> = { "15": 11, "60": 9, "230": 7 };

export type WideView = { zoom: number; cfKhz: number };

export function spanKhz(zoom: number): number {
  return KIWI_SPAN_KHZ / 2 ** zoom;
}

/** The dial band a frequency is in, broadcast before ham, or none. */
export function bandAt(freqKhz: number): Band | undefined {
  return [...BROADCAST_BANDS, ...HAM_BANDS].find((b) => freqKhz >= b.startKhz && freqKhz <= b.endKhz);
}

/** The closest zoom that shows all of a band, with a little room either side. */
export function bandZoom(band: Band): number {
  const want = (band.endKhz - band.startKhz) * 1.1;
  for (let zoom = MAX_ZOOM; zoom > 0; zoom--) if (spanKhz(zoom) >= want) return zoom;
  return 0;
}

/** The view moves once the tuned frequency comes this share of the span from an edge. */
const EDGE = 0.1;

/**
 * Where the wide waterfall should look: none for the audio view, the whole
 * band for "band", else centred on the tuned frequency. It stays put (the
 * same object) while the frequency moves inside it, so tuning across a view
 * doesn't keep repointing the receiver.
 */
export function nextView(step: SpanStep, freqKhz: number, current: WideView | null): WideView | null {
  if (step === "audio") return null;
  let next: WideView;
  if (step === "band") {
    const band = bandAt(freqKhz);
    if (!band) return null;
    next = { zoom: bandZoom(band), cfKhz: (band.startKhz + band.endKhz) / 2 };
  } else {
    const zoom = ZOOMS[step];
    if (current?.zoom === zoom && Math.abs(freqKhz - current.cfKhz) <= spanKhz(zoom) * (0.5 - EDGE)) return current;
    next = { zoom, cfKhz: freqKhz };
  }
  return current?.zoom === next.zoom && current.cfKhz === next.cfKhz ? current : next;
}

/** Tick spacing for an axis across `span` kHz: a round step giving about four to eight ticks. */
export function tickStepKhz(span: number): number {
  for (const step of [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]) {
    if (span / step <= 8) return step;
  }
  return 10_000;
}
