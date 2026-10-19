"use client";

import { useCallback, useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { BROADCAST_BANDS, DIAL_MAX_KHZ, DIAL_MIN_KHZ, HAM_BANDS, type Band } from "@/lib/radio-types";

const W = 1000;
const H = 160;
const PAD = 20;
const SCALE_Y = 92;

const x = (khz: number) => PAD + ((khz - DIAL_MIN_KHZ) / (DIAL_MAX_KHZ - DIAL_MIN_KHZ)) * (W - PAD * 2);

function ticks() {
  const minor: string[] = [];
  const major: string[] = [];
  for (let khz = DIAL_MIN_KHZ; khz <= DIAL_MAX_KHZ; khz += 250) {
    const px = x(khz).toFixed(2);
    if (khz % 1000 === 0) major.push(`M${px} ${SCALE_Y}v${khz % 5000 === 0 ? 18 : 12}`);
    else minor.push(`M${px} ${SCALE_Y}v6`);
  }
  return { minor: minor.join(""), major: major.join("") };
}
const TICKS = ticks();

function BandRow({
  bands,
  y,
  labelY,
  className,
}: {
  bands: Band[];
  y: number;
  labelY: [number, number];
  className: string;
}) {
  return (
    <g className={className}>
      {bands.map((b, i) => {
        const x0 = x(b.startKhz);
        const width = Math.max(3, x(b.endKhz) - x0);
        // Stagger labels on alternate bands so neighbors don't collide.
        return (
          <g key={b.name}>
            <rect x={x0} y={y} width={width} height={8} rx={1.5} />
            <text x={x0 + width / 2} y={labelY[i % 2]} textAnchor="middle">
              {b.name}
            </text>
          </g>
        );
      })}
    </g>
  );
}

type Props = {
  freqKhz: number;
  onChange: (khz: number) => void;
};

export function Dial({ freqKhz, onChange }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);

  const fromPointer = useCallback(
    (clientX: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const vx = ((clientX - rect.left) / rect.width) * W;
      const khz = ((vx - PAD) / (W - PAD * 2)) * (DIAL_MAX_KHZ - DIAL_MIN_KHZ) + DIAL_MIN_KHZ;
      // Coarse tuning snaps to 5 kHz, the broadcast channel spacing.
      const snapped = Math.round(khz / 5) * 5;
      onChange(Math.min(DIAL_MAX_KHZ, Math.max(10, snapped)));
    },
    [onChange],
  );

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    fromPointer(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (dragging.current) fromPointer(e.clientX);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const steps: Record<string, number> = {
      ArrowRight: e.shiftKey ? 10 : 1,
      ArrowLeft: e.shiftKey ? -10 : -1,
      ArrowUp: e.shiftKey ? 10 : 1,
      ArrowDown: e.shiftKey ? -10 : -1,
      PageUp: 100,
      PageDown: -100,
    };
    const step = steps[e.key];
    if (step === undefined) return;
    e.preventDefault();
    onChange(Math.min(DIAL_MAX_KHZ, Math.max(10, Math.round((freqKhz + step) * 100) / 100)));
  };

  const needle = x(freqKhz);

  // On narrow screens the dial scrolls sideways; keep the needle in view when
  // the frequency changes from somewhere other than a drag on the dial.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = scrollRef.current;
    const svg = svgRef.current;
    if (!box || !svg || dragging.current || box.scrollWidth <= box.clientWidth) return;
    const px = (needle / W) * svg.clientWidth;
    if (px < box.scrollLeft + 40 || px > box.scrollLeft + box.clientWidth - 40) {
      box.scrollTo({ left: px - box.clientWidth / 2 });
    }
  }, [needle]);

  return (
    <div className="dial">
      <div className="dial-scroll" ref={scrollRef}>
        <svg
          ref={svgRef}
          className="dial-glass"
          viewBox={`0 0 ${W} ${H}`}
          role="slider"
          tabIndex={0}
          aria-label="Tuning dial"
          aria-valuemin={DIAL_MIN_KHZ}
          aria-valuemax={DIAL_MAX_KHZ}
          aria-valuenow={freqKhz}
          aria-valuetext={`${freqKhz.toLocaleString()} kilohertz`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          <text className="dial-row-label" x={PAD} y={14}>
            Broadcast
          </text>
          <BandRow bands={BROADCAST_BANDS} y={32} labelY={[27, 54]} className="dial-band dial-band-broadcast" />
          <text className="dial-row-label" x={PAD} y={154}>
            Amateur
          </text>
          <path className="dial-ticks-minor" d={TICKS.minor} />
          <path className="dial-ticks-major" d={TICKS.major} />
          <line className="dial-baseline" x1={PAD} x2={W - PAD} y1={SCALE_Y} y2={SCALE_Y} />
          {Array.from({ length: 31 }, (_, mhz) => (
            <text
              key={mhz}
              className={mhz % 5 === 0 ? "dial-num dial-num-major" : "dial-num"}
              x={x(mhz * 1000)}
              y={SCALE_Y - 6}
              textAnchor="middle"
            >
              {mhz}
            </text>
          ))}
          <BandRow bands={HAM_BANDS} y={118} labelY={[141, 154]} className="dial-band dial-band-ham" />
          <g className="dial-needle" transform={`translate(${needle.toFixed(2)} 0)`}>
            <line x1={0} x2={0} y1={4} y2={H - 4} />
            <circle cx={0} cy={4} r={3.5} />
          </g>
        </svg>
      </div>
      <p className="dial-hint">Drag to tune, or focus the dial and use the arrow keys. Shift steps by 10 kHz.</p>
    </div>
  );
}
