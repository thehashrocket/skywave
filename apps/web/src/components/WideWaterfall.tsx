"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { WideFrame } from "@/lib/use-radio";
import { spanKhz, tickStepKhz, type WideView } from "@/lib/wide-view";
import { createPainter, ROWS, type Painter } from "./Waterfall";

type Shown = { startKhz: number; spanKhz: number };

/** Where a view should land, until its first frame says where it did. */
function nominal(view: WideView): Shown {
  const span = spanKhz(view.zoom);
  return { startKhz: view.cfKhz - span / 2, spanKhz: span };
}

function label(khz: number) {
  return khz.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

type Props = {
  view: WideView;
  /** The tuned frequency, marked on the picture. */
  freqKhz: number;
  /** What the receiver passes to the audio, in RF kHz. */
  passband: [number, number];
  /** A band scan has the receiver's waterfall: the picture holds still until it's done. */
  frozen: boolean;
  /** Why the receiver's waterfall can't be shown, if it can't. */
  error: string | null;
  subscribe: (fn: (frame: WideFrame) => void) => () => void;
  /** Called with the RF frequency (kHz) under a click. */
  onTune: (khz: number) => void;
};

/**
 * The receiver's own waterfall, kilohertz wide: where the stations are around
 * the one playing. Frames say where they landed (a receiver keeps a view
 * inside what it covers), and the marks and axis follow them.
 */
export function WideWaterfall({ view, freqKhz, passband, frozen, error, subscribe, onTune }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painterRef = useRef<Painter | null>(null);
  const [shown, setShown] = useState<Shown>(() => nominal(view));
  const shownRef = useRef(shown);
  // Whether a frame has come since this waterfall appeared: until then it's opening.
  const [received, setReceived] = useState(false);
  const receivedRef = useRef(false);
  // Whether a frame of the current view has come: until then the picture is
  // blank and placed only where the view should land, so it takes no clicks.
  const [placed, setPlaced] = useState(false);
  const placedRef = useRef(false);

  // A new view: the old picture goes, and it's placed where the view should land.
  const [forView, setForView] = useState(view);
  if (forView !== view) {
    setForView(view);
    const next = nominal(view);
    shownRef.current = next;
    setShown(next);
    placedRef.current = false;
    setPlaced(false);
  }
  useEffect(() => {
    painterRef.current?.clear();
  }, [view]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;
    const painter = createPainter(canvas, ctx);
    painterRef.current = painter;
    return subscribe((frame) => {
      // Rendered only when something changed: frames come about ten a second.
      if (!receivedRef.current) {
        receivedRef.current = true;
        setReceived(true);
      }
      if (!placedRef.current) {
        placedRef.current = true;
        setPlaced(true);
      }
      const at = shownRef.current;
      if (at.startKhz !== frame.startKhz || at.spanKhz !== frame.spanKhz) {
        shownRef.current = { startKhz: frame.startKhz, spanKhz: frame.spanKhz };
        setShown(shownRef.current);
      }
      painter.paint(frame.row);
    });
  }, [subscribe]);

  const { startKhz, spanKhz: span } = shown;
  const endKhz = startKhz + span;
  const pct = (khz: number) => ((khz - startKhz) / span) * 100;
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const [lo, hi] = passband;
  const step = tickStepKhz(span);
  const ticks: number[] = [];
  for (let k = Math.ceil(startKhz / step) * step; k <= endKhz; k += step) {
    // Not at the very edges, where a label would hang off the picture.
    if (pct(k) >= 6 && pct(k) <= 94) ticks.push(k);
  }
  const clickable = placed && !frozen && !error;
  const message =
    error ??
    (frozen
      ? "Scanning the bands… the waterfall carries on when the scan is done."
      : received
        ? null
        : "Opening the receiver's waterfall…");

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!clickable) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onTune(startKhz + ((e.clientX - rect.left) / rect.width) * span);
  };

  return (
    <figure className="waterfall" data-open data-wide>
      <div
        className="waterfall-screen"
        onClick={handleClick}
        title={clickable ? "Click a signal to tune to it" : undefined}
        data-active={clickable || undefined}
      >
        <canvas ref={canvasRef} width={1024} height={ROWS} aria-hidden="true" />
        {hi >= startKhz && lo <= endKhz && (
          <div
            className="waterfall-passband"
            style={{ left: `${clamp(pct(lo))}%`, width: `${clamp(pct(hi)) - clamp(pct(lo))}%` }}
          />
        )}
        {freqKhz >= startKhz && freqKhz <= endKhz && (
          <div className="waterfall-center" style={{ left: `${pct(freqKhz)}%` }} />
        )}
        {message && (
          <p className="waterfall-empty" role={error ? "alert" : undefined}>
            <span>{message}</span>
          </p>
        )}
      </div>
      <figcaption className="waterfall-axis">
        {ticks.map((k) => (
          <span key={k} style={{ left: `${pct(k)}%` }}>
            {label(k)}
          </span>
        ))}
        <span className="waterfall-unit">
          kHz · <span className="hint-fine">Click a signal to tune to it.</span>
          <span className="hint-coarse" aria-hidden="true">
            Tap a signal to tune to it.
          </span>
        </span>
      </figcaption>
    </figure>
  );
}
