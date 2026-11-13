"use client";

import { useEffect, useRef } from "react";

/** The canvas's size in canvas pixels; CSS stretches it to the panel. */
const WIDTH = 320;
const HEIGHT = 56;
// The window shown, in dBFS: quiet speech sits low, a loud carrier near the top.
const MIN_DB = -100;
const MAX_DB = -20;

/**
 * How many of an analyser's bins to show: those up to `maxHz`, of
 * `binCount` bins spread from 0 to half `contextRate`.
 */
export function shownBins(binCount: number, contextRate: number, maxHz: number): number {
  const nyquist = contextRate / 2;
  return Math.max(1, Math.min(binCount, Math.floor((Math.min(maxHz, nyquist) / nyquist) * binCount)));
}

/** Where each bin's level sits, in canvas pixels from the top: MIN_DB at the bottom, MAX_DB at the top. */
export function audioYs(db: Float32Array, count: number, height: number): Float32Array {
  const ys = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = db[i]!;
    // A silent bin comes back as -Infinity.
    const t = Number.isFinite(v) ? Math.max(0, Math.min(1, (v - MIN_DB) / (MAX_DB - MIN_DB))) : 0;
    ys[i] = height - t * height;
  }
  return ys;
}

type Props = {
  /** The analyser on what's playing (useRadio's getAnalyser); null before audio starts. */
  getAnalyser: () => AnalyserNode | null;
  /** Audio is playing: the spectrum moves. Otherwise it lies flat. */
  active: boolean;
  /** The radio's audio rate: the spectrum goes up to half of it, where the audio ends. */
  sampleRate: number;
};

/**
 * The audio coming out of the speaker, as a spectrum from 0 Hz up: a rig's
 * AF-FFT. It shows the shape of what the passband lets through, and that the
 * audio is alive when a station pauses. Decorative: the S-meter and the
 * status say the same in words.
 */
export function AudioSpectrum({ getAnalyser, active, sampleRate }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maxHz = sampleRate / 2;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    if (!active) return;
    const style = getComputedStyle(document.documentElement);
    const line = style.getPropertyValue("--wf-4").trim() || "#fff8de";
    const wash = style.getPropertyValue("--wf-2").trim() || "#70b29e";
    let data: Float32Array<ArrayBuffer> | null = null;
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const analyser = getAnalyser();
      if (!analyser) return;
      if (data?.length !== analyser.frequencyBinCount) data = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(data);
      const count = shownBins(data.length, analyser.context.sampleRate, maxHz);
      const ys = audioYs(data, count, HEIGHT);
      const x = (i: number) => (i / Math.max(1, count - 1)) * WIDTH;
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      ctx.beginPath();
      ctx.moveTo(0, HEIGHT);
      for (let i = 0; i < count; i++) ctx.lineTo(x(i), ys[i]!);
      ctx.lineTo(WIDTH, HEIGHT);
      ctx.closePath();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = wash;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
    };
  }, [active, getAnalyser, maxHz]);

  const ticks: number[] = [];
  for (let k = 0; k * 1000 <= maxHz; k++) ticks.push(k);

  return (
    <figure className="audio-spectrum" aria-hidden="true">
      <figcaption className="audio-spectrum-name">Audio</figcaption>
      <div className="audio-spectrum-screen">
        <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} />
      </div>
      <div className="audio-spectrum-axis">
        {ticks.map((k, i) => (
          <span key={k} style={{ left: `${((k * 1000) / maxHz) * 100}%` }}>
            {i === ticks.length - 1 ? `${k} kHz` : k}
          </span>
        ))}
      </div>
    </figure>
  );
}
