"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { DIAL_MAX_KHZ, inTuneRange, TUNE_MIN_KHZ } from "@/lib/radio-types";

const RANGE_HINT = `Enter ${TUNE_MIN_KHZ.toLocaleString("en-US")} to ${DIAL_MAX_KHZ.toLocaleString("en-US")} kHz`;

/** The longest entry the readout takes ("29,999.99 kHz" with room to spare). */
const MAX_INPUT = 32;

function format(khz: number) {
  return khz.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * What the user typed, as kHz rounded to 10 Hz, or null if it isn't a tunable
 * frequency. Digits with thousands separators and one decimal point, then an
 * optional unit: kHz (or k) or MHz (or M, with a decimal point: "20m" is a
 * band name). Anything else, a minus sign included, is rejected rather than stripped.
 */
export function parseFrequencyKhz(text: string): number | null {
  // Longer text is never a frequency; the cap also keeps the parse cheap.
  if (text.length > MAX_INPUT) return null;
  const trimmed = text.trim();
  // An anchored suffix and plain trims: no regex here can backtrack on long runs of spaces.
  const unit = /(khz|k|mhz|m)$/i.exec(trimmed)?.[1]?.toLowerCase();
  const digits = (unit ? trimmed.slice(0, -unit.length) : trimmed).trimEnd();
  // Commas and spaces only as thousands separators: "1,5" is a decimal comma, not 15.
  if (!/^(\d{1,3}(,\d{3})+|\d{1,3}( \d{3})+|\d+)(\.\d+)?$/.test(digits)) return null;
  // A bare "m" after a whole number reads like a band name ("20m"), which the dial labels that way.
  if (unit === "m" && !digits.includes(".")) return null;
  const value = Number(digits.replace(/[,\s]/g, "")) * (unit?.startsWith("m") ? 1000 : 1);
  if (!Number.isFinite(value) || !inTuneRange(value)) return null;
  return Math.round(value * 100) / 100;
}

export function FrequencyReadout({ freqKhz, onChange }: { freqKhz: number; onChange: (khz: number) => void }) {
  const [draft, setDraft] = useState(format(freqKhz));
  const [editing, setEditing] = useState(false);
  // A typed value that isn't a tunable frequency: it stays in the box, flagged, until fixed or Escape.
  const [invalid, setInvalid] = useState(false);
  const cancelling = useRef(false);
  // Whether anything was typed since focus: leaving the box untouched (say, for
  // the dial) must not re-tune it to the frequency it showed on focus.
  const edited = useRef(false);
  // The frequency the box last showed, so a rejected entry survives until a tune from elsewhere.
  const shown = useRef(freqKhz);

  useEffect(() => {
    // A tune from elsewhere mid-edit still counts, so a rejected entry left afterwards keeps its flag.
    if (editing) {
      shown.current = freqKhz;
      return;
    }
    if (invalid && shown.current === freqKhz) return;
    shown.current = freqKhz;
    setDraft(format(freqKhz));
    setInvalid(false);
  }, [freqKhz, editing, invalid]);

  const commit = (e?: FormEvent) => {
    e?.preventDefault();
    const khz = parseFrequencyKhz(draft);
    if (khz === null) {
      setInvalid(true);
      // Enter keeps the box in hand to fix it; leaving it keeps the text, flagged.
      if (!e) setEditing(false);
      return;
    }
    onChange(khz);
    edited.current = false; // committed: a later blur has nothing new to send
    setInvalid(false);
    setEditing(false);
  };

  return (
    <form className="readout" onSubmit={commit}>
      <label htmlFor="freq" className="visually-hidden">
        Frequency in kilohertz
      </label>
      <input
        id="freq"
        className="readout-input"
        inputMode="decimal"
        maxLength={MAX_INPUT}
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onFocus={(e) => {
          edited.current = false;
          setEditing(true);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          edited.current = true;
          setDraft(e.target.value);
        }}
        onBlur={() => {
          if (cancelling.current) {
            cancelling.current = false;
            setDraft(format(freqKhz));
            setInvalid(false);
            setEditing(false);
          } else if (edited.current) {
            commit();
          } else {
            setEditing(false);
          }
        }}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? "freq-error" : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // blur() runs onBlur right away, while `draft` still holds the
            // typed text, so tell it to discard rather than commit.
            cancelling.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      <span className="readout-unit">kHz</span>
      {/* Always present, so the alert is announced when its text appears. */}
      <p id="freq-error" className="readout-error" role="alert">
        {invalid && RANGE_HINT}
      </p>
    </form>
  );
}
