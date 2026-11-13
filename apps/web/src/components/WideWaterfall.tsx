"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { WideFrame } from "@/lib/use-radio";
import { spanKhz, tickStepKhz, type WideView } from "@/lib/wide-view";
import { createPainter, ROWS, TRACE_ROWS, traceTarget, type Painter } from "./Waterfall";

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
  /** Who the schedule has on the air around here now, by frequency. */
  stations?: readonly ScheduledHere[];
};

/** A scheduled frequency and its short label ("Voice of Turkey +1"). */
export type ScheduledHere = { khz: number; label: string };

/** Room a station label takes, in pixels: names past it are cut short. */
const LABEL_PX = 158;

/**
 * Which stations get a label, as fractions of the width: the one nearest the
 * tuned frequency first, then outwards, each only where it clears the ones
 * already placed. The rest keep just their mark.
 */
export function placeLabels(at: readonly number[], tuned: number, widthPx: number): Set<number> {
  const gap = widthPx > 0 ? LABEL_PX / widthPx : 1;
  const placed: number[] = [];
  const order = at.map((x, i) => i).sort((a, b) => Math.abs(at[a]! - tuned) - Math.abs(at[b]! - tuned));
  const out = new Set<number>();
  for (const i of order) {
    const x = at[i]!;
    // Not where a label would hang off the picture.
    if (x < gap / 2 || x > 1 - gap / 2) continue;
    if (placed.some((p) => Math.abs(p - x) < gap)) continue;
    placed.push(x);
    out.add(i);
  }
  return out;
}

/**
 * The receiver's own waterfall, kilohertz wide: where the stations are around
 * the one playing. Frames say where they landed (a receiver keeps a view
 * inside what it covers), and the marks and axis follow them.
 */
export function WideWaterfall({ view, freqKhz, passband, frozen, error, subscribe, onTune, stations = [] }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const traceRef = useRef<HTMLCanvasElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  // The picture's width, for how many station labels fit.
  const [widthPx, setWidthPx] = useState(0);
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidthPx(entry!.contentRect.width));
    observer.observe(screen);
    return () => observer.disconnect();
  }, []);
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
    const painter = createPainter(canvas, ctx, traceTarget(traceRef.current));
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
  const here = stations.filter((s) => s.khz >= startKhz && s.khz <= endKhz);
  const labelled = placeLabels(
    here.map((s) => pct(s.khz) / 100),
    pct(freqKhz) / 100,
    widthPx,
  );
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
        ref={screenRef}
        className="waterfall-screen"
        onClick={handleClick}
        title={clickable ? "Click a signal to tune to it" : undefined}
        data-active={clickable || undefined}
      >
        <canvas ref={traceRef} className="waterfall-trace" width={1024} height={TRACE_ROWS} aria-hidden="true" />
        <canvas ref={canvasRef} className="waterfall-picture" width={1024} height={ROWS} aria-hidden="true" />
        {hi >= startKhz && lo <= endKhz && (
          <div
            className="waterfall-passband"
            style={{ left: `${clamp(pct(lo))}%`, width: `${clamp(pct(hi)) - clamp(pct(lo))}%` }}
          />
        )}
        {freqKhz >= startKhz && freqKhz <= endKhz && (
          <div className="waterfall-center" style={{ left: `${pct(freqKhz)}%` }} />
        )}
        {/* What the schedule has on: a mark on each frequency, a name where one fits. The readout says it in words. */}
        {here.length > 0 && !message && (
          <div className="waterfall-stations" aria-hidden="true">
            {here.map((s, i) => (
              <span key={s.khz} className="waterfall-station" style={{ left: `${pct(s.khz)}%` }}>
                {labelled.has(i) && <span className="waterfall-station-name">{s.label}</span>}
              </span>
            ))}
          </div>
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
