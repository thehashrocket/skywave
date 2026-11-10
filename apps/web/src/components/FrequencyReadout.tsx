"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { DIAL_MAX_KHZ, inTuneRange, stepKhz, TUNE_MIN_KHZ } from "@/lib/radio-types";

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

/**
 * Wheel movement that makes one notch. A mouse wheel's notch (or any line- or
 * page-based delta) is one notch on its own; a trackpad's small pixel deltas
 * add up to one.
 */
const NOTCH_PX = 50;

/**
 * How long the pointer must rest on the number, with no wheel movement, before
 * the wheel tunes. A page scroll that passes over the readout keeps scrolling
 * instead of changing the station; focus (a click, Tab) arms it at once.
 */
export const WHEEL_REST_MS = 500;

export function FrequencyReadout({
  freqKhz,
  onChange,
  step,
}: {
  freqKhz: number;
  onChange: (khz: number) => void;
  /** One wheel notch or arrow key press in kHz (Shift: ten); none turns both off. */
  step?: number;
}) {
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
  const inputRef = useRef<HTMLInputElement>(null);
  // What stepping reads. `step` and `onChange` are the latest props; `freqKhz`
  // runs ahead of them, set to each step as it's sent, so several steps before
  // the page re-renders count on from one another. `total` is a trackpad's
  // running wheel delta.
  const tuner = useRef({ freqKhz, step, onChange, total: 0 });
  tuner.current.step = step;
  tuner.current.onChange = onChange;
  useEffect(() => {
    tuner.current.freqKhz = freqKhz;
  }, [freqKhz]);

  /**
   * One step up or down (ten with `coarse`). False when stepping is off: no
   * step given, or typed text in the box (being typed, or rejected and still
   * showing), which a step would throw away.
   */
  const nudge = useCallback((dir: 1 | -1, coarse: boolean): boolean => {
    const t = tuner.current;
    if (!t.step || edited.current) return false;
    const next = stepKhz(t.freqKhz, t.step * (coarse ? 10 : 1), dir);
    if (next !== t.freqKhz) {
      t.freqKhz = next;
      t.onChange(next);
    }
    return true;
  }, []);

  // A wheel over the number tunes in steps instead of scrolling the page, once
  // the pointer has rested there or the box has focus. It needs a listener that
  // isn't passive, which React's onWheel is.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    // Armed once the pointer has rested on the number for WHEEL_REST_MS.
    let rested = false;
    let rest: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(rest);
      rested = false;
      rest = setTimeout(() => (rested = true), WHEEL_REST_MS);
    };
    const leave = () => {
      clearTimeout(rest);
      rested = false;
    };
    const onWheel = (e: WheelEvent) => {
      const t = tuner.current;
      // Shift turns a mouse wheel sideways on some systems.
      const delta = e.deltaY || (e.shiftKey ? e.deltaX : 0);
      if (!delta || !t.step || edited.current) return; // the page scrolls as usual
      if (!rested && document.activeElement !== input) {
        // Passing over the number mid-scroll: keep scrolling, and wait for a rest.
        restart();
        return;
      }
      e.preventDefault();
      let sum = delta;
      if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(delta) < NOTCH_PX) {
        // A change of direction starts the count again.
        t.total = Math.sign(t.total) === Math.sign(delta) ? t.total + delta : delta;
        if (Math.abs(t.total) < NOTCH_PX) return;
        sum = t.total;
      }
      t.total = 0;
      // Wheel up (a negative delta) tunes up.
      nudge(sum < 0 ? 1 : -1, e.shiftKey);
    };
    input.addEventListener("wheel", onWheel, { passive: false });
    input.addEventListener("pointerenter", restart);
    input.addEventListener("pointerleave", leave);
    return () => {
      clearTimeout(rest);
      input.removeEventListener("wheel", onWheel);
      input.removeEventListener("pointerenter", restart);
      input.removeEventListener("pointerleave", leave);
    };
  }, [nudge]);

  useEffect(() => {
    // A tune from elsewhere mid-edit still counts, so a rejected entry left afterwards keeps its flag.
    if (editing) {
      shown.current = freqKhz;
      // Focused but nothing typed (the wheel or arrows tuning it): show the new frequency.
      if (!edited.current) setDraft(format(freqKhz));
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
        ref={inputRef}
        id="freq"
        className="readout-input"
        title={step ? "Rest the pointer here and scroll, or use the up and down arrow keys, to fine-tune" : undefined}
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
            edited.current = false; // what was typed is gone, so stepping works again
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
          // Arrow keys step like the wheel, unless there's typed text to move the caret in.
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && nudge(e.key === "ArrowUp" ? 1 : -1, e.shiftKey)) {
            e.preventDefault();
            return;
          }
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
