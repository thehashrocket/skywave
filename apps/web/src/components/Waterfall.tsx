"use client";

import { useEffect, useRef, type MouseEvent } from "react";
import { PASSBANDS, type Mode } from "@/lib/radio-types";

const ROWS = 220;
// The waterfall shows FLOOR_OFFSET_DB below the noise floor up to RANGE_DB above
// that. The radio service's uint8 rows (SPECTRUM_FLOOR_MARGIN_DB in
// apps/radio/skywave_radio/dsp.py) must cover this window, so change both together.
const RANGE_DB = 55;
const FLOOR_OFFSET_DB = 3;
// Must match SPECTRUM_FLOOR_PERCENTILE in apps/radio/skywave_radio/dsp.py.
const FLOOR_PERCENTILE = 0.2;

type Rgb = [number, number, number];

// Deep enamel to dial-glass celadon to lamp amber: same family as the panel.
// The colors come from the --wf-* tokens in globals.css; these are their
// values, for a stylesheet that can't be read (tests, or a missing token).
const STOP_AT = [0, 0.35, 0.6, 0.82, 1] as const;
export const FALLBACK_STOPS: Rgb[] = [
  [11, 30, 36],
  [27, 84, 92],
  [112, 178, 158],
  [232, 210, 122],
  [255, 248, 222],
];

/** "#rrggbb" or "rgb(r, g, b)" as numbers, or null. */
export function parseColor(value: string): Rgb | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
  if (hex) return [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16)];
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(v);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/** The colormap stops, read through `read` (getComputedStyle in the browser); unreadable ones fall back. */
export function resolveStops(read: (name: string) => string): Rgb[] {
  return FALLBACK_STOPS.map((fallback, i) => parseColor(read(`--wf-${i}`)) ?? fallback);
}

function buildLut(colors: Rgb[]) {
  const stops = STOP_AT.map((t, i) => [t, colors[i]!] as const);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;
    const [t0, c0] = stops[k]!;
    const [t1, c1] = stops[k + 1]!;
    const f = (t - t0) / (t1 - t0);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = c0[c]! + (c1[c]! - c0[c]!) * f;
  }
  return lut;
}

type Props = {
  mode: Mode;
  sampleRate: number;
  active: boolean;
  /** Full height once the visit's first audio has played; a short strip until then. */
  expanded: boolean;
  /** A tune is under way, so the strip says so instead of asking for Listen. */
  connecting: boolean;
  subscribe: (fn: (row: Float32Array, sampleRate: number) => void) => () => void;
  /** Called with a frequency offset in Hz when the waterfall is clicked. */
  onClickOffset: (hz: number) => void;
};

export function Waterfall({ mode, sampleRate, active, expanded, connecting, subscribe, onClickOffset }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const floorRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;
    // Read on mount: the tokens only exist once the stylesheet applies.
    const style = getComputedStyle(document.documentElement);
    const colors = resolveStops((name) => style.getPropertyValue(name));
    const lut = buildLut(colors);
    const fill = `rgb(${colors[0]!.join(",")})`;
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    return subscribe((row) => {
      if (canvas.width !== row.length) {
        canvas.width = row.length;
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      // Auto-level: track the noise floor (FLOOR_PERCENTILE of the row) slowly.
      const sorted = Float32Array.from(row).sort();
      const rowFloor = sorted[Math.floor(sorted.length * FLOOR_PERCENTILE)]!;
      floorRef.current = floorRef.current === null ? rowFloor : floorRef.current * 0.95 + rowFloor * 0.05;
      const floor = floorRef.current - FLOOR_OFFSET_DB;

      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height - 1, 0, 1, canvas.width, canvas.height - 1);
      const img = ctx.createImageData(row.length, 1);
      for (let i = 0; i < row.length; i++) {
        const v = Math.max(0, Math.min(255, ((row[i]! - floor) / RANGE_DB) * 255)) | 0;
        img.data[i * 4] = lut[v * 3]!;
        img.data[i * 4 + 1] = lut[v * 3 + 1]!;
        img.data[i * 4 + 2] = lut[v * 3 + 2]!;
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
  }, [subscribe]);

  const span = sampleRate;
  const [lo, hi] = PASSBANDS[mode];
  const pct = (hz: number) => ((hz + span / 2) / span) * 100;

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    // Nothing on screen to aim at: an idle or still-collapsed strip, or a stopped radio, doesn't tune.
    if (!active || !expanded) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const hz = ((e.clientX - rect.left) / rect.width - 0.5) * span;
    onClickOffset(Math.round(hz / 10) * 10);
  };

  const axis = [-6, -4, -2, 0, 2, 4, 6].filter((k) => Math.abs(k * 1000) <= span / 2);

  return (
    <figure className="waterfall" data-open={expanded || undefined}>
      <div
        className="waterfall-screen"
        onClick={handleClick}
        title={active && expanded ? "Click a signal to tune to it" : undefined}
        data-active={(active && expanded) || undefined}
      >
        <canvas ref={canvasRef} width={512} height={ROWS} aria-hidden="true" />
        <div className="waterfall-passband" style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }} />
        <div className="waterfall-center" />
        {!(active && expanded) && (
          <p className="waterfall-empty">
            {expanded
              ? "The waterfall fills in once you're listening."
              : connecting || active
                ? "Tuning in…"
                : "Press Listen to hear the band. A blank receiver picks the best one."}
          </p>
        )}
      </div>
      <figcaption className="waterfall-axis">
        {axis.map((k) => (
          <span key={k} style={{ left: `${pct(k * 1000)}%` }}>
            {k > 0 ? `+${k}` : k}
          </span>
        ))}
        <span className="waterfall-unit">
          kHz from tuned frequency ·{" "}
          {/* Screen readers get the click sentence; a touch screen shows the tap one instead. */}
          <span className="hint-fine">Click a signal to tune to it.</span>
          <span className="hint-coarse" aria-hidden="true">
            Tap a signal to tune to it.
          </span>
        </span>
      </figcaption>
    </figure>
  );
}
