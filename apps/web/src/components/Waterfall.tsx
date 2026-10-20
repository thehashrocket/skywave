"use client";

import { useEffect, useRef, type MouseEvent } from "react";
import { PASSBANDS, type Mode } from "@/lib/radio-types";

const ROWS = 220;
const RANGE_DB = 55;

// Deep enamel to dial-glass celadon to lamp amber: same family as the panel.
const STOPS: [number, [number, number, number]][] = [
  [0, [11, 30, 36]],
  [0.35, [27, 84, 92]],
  [0.6, [112, 178, 158]],
  [0.82, [232, 210, 122]],
  [1, [255, 248, 222]],
];

function buildLut() {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && t > STOPS[k + 1]![0]) k++;
    const [t0, c0] = STOPS[k]!;
    const [t1, c1] = STOPS[k + 1]!;
    const f = (t - t0) / (t1 - t0);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = c0[c]! + (c1[c]! - c0[c]!) * f;
  }
  return lut;
}
const LUT = buildLut();

type Props = {
  mode: Mode;
  sampleRate: number;
  active: boolean;
  subscribe: (fn: (row: Float32Array, sampleRate: number) => void) => () => void;
  /** Called with a frequency offset in Hz when the waterfall is clicked. */
  onClickOffset: (hz: number) => void;
};

export function Waterfall({ mode, sampleRate, active, subscribe, onClickOffset }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const floorRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;
    ctx.fillStyle = "rgb(11,30,36)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    return subscribe((row) => {
      if (canvas.width !== row.length) {
        canvas.width = row.length;
        ctx.fillStyle = "rgb(11,30,36)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      // Auto-level: track the noise floor (20th percentile) slowly. The radio
      // service anchors each row's uint8 range on the same percentile
      // (SPECTRUM_FLOOR_PERCENTILE in apps/radio/skywave_radio/dsp.py).
      const sorted = Float32Array.from(row).sort();
      const p20 = sorted[Math.floor(sorted.length * 0.2)]!;
      floorRef.current = floorRef.current === null ? p20 : floorRef.current * 0.95 + p20 * 0.05;
      const floor = floorRef.current - 3;

      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height - 1, 0, 1, canvas.width, canvas.height - 1);
      const img = ctx.createImageData(row.length, 1);
      for (let i = 0; i < row.length; i++) {
        const v = Math.max(0, Math.min(255, ((row[i]! - floor) / RANGE_DB) * 255)) | 0;
        img.data[i * 4] = LUT[v * 3]!;
        img.data[i * 4 + 1] = LUT[v * 3 + 1]!;
        img.data[i * 4 + 2] = LUT[v * 3 + 2]!;
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
  }, [subscribe]);

  const span = sampleRate;
  const [lo, hi] = PASSBANDS[mode];
  const pct = (hz: number) => ((hz + span / 2) / span) * 100;

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hz = ((e.clientX - rect.left) / rect.width - 0.5) * span;
    onClickOffset(Math.round(hz / 10) * 10);
  };

  const axis = [-6, -4, -2, 0, 2, 4, 6].filter((k) => Math.abs(k * 1000) <= span / 2);

  return (
    <figure className="waterfall">
      <div
        className="waterfall-screen"
        onClick={handleClick}
        title="Click a signal to tune to it"
        data-active={active || undefined}
      >
        <canvas ref={canvasRef} width={512} height={ROWS} aria-hidden="true" />
        <div className="waterfall-passband" style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }} />
        <div className="waterfall-center" />
        {!active && <p className="waterfall-empty">The waterfall fills in once you're listening.</p>}
      </div>
      <figcaption className="waterfall-axis">
        {axis.map((k) => (
          <span key={k} style={{ left: `${pct(k * 1000)}%` }}>
            {k > 0 ? `+${k}` : k}
          </span>
        ))}
        <span className="waterfall-unit">kHz from tuned frequency</span>
      </figcaption>
    </figure>
  );
}
