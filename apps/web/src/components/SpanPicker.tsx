"use client";

import type { Band } from "@/lib/radio-types";
import { SPAN_STEPS, type SpanStep } from "@/lib/wide-view";

/** Why a width can't be chosen now, if it can't. */
function why(step: SpanStep, band: Band | undefined, canView: boolean): string | undefined {
  if (step === "audio") return undefined;
  if (!canView) return "The radio service can't show the receiver's own waterfall";
  if (step === "band" && !band) return "Tune into a band to see all of it";
  return undefined;
}

function label(step: SpanStep, band: Band | undefined) {
  if (step === "audio") return "Audio";
  if (step === "band") return band ? `${band.name} band` : "Band";
  return `${step} kHz`;
}

/**
 * How wide the waterfall looks: the audio passband, or the receiver's own
 * waterfall at about 15, 60 or 230 kHz, or the whole band the dial is in.
 * Only the audio view works without a radio service that can stream the
 * receiver's waterfall; "band" needs the dial in a band.
 */
export function SpanPicker({
  step,
  waiting = false,
  band,
  canView,
  onChange,
}: {
  step: SpanStep;
  /** A wide width is chosen but the receiver hasn't played long enough to be asked for its waterfall. */
  waiting?: boolean;
  band: Band | undefined;
  canView: boolean;
  onChange: (step: SpanStep) => void;
}) {
  return (
    <div className="span-picker" role="group" aria-label="Waterfall width">
      {SPAN_STEPS.map((s) => {
        const reason = why(s, band, canView);
        return (
          <button
            key={s}
            type="button"
            className="span-step"
            aria-pressed={s === step}
            disabled={reason !== undefined}
            title={reason}
            onClick={() => onChange(s)}
          >
            {label(s, band)}
          </button>
        );
      })}
      {waiting && <span className="span-note">The receiver&apos;s waterfall starts in a few seconds.</span>}
    </div>
  );
}
