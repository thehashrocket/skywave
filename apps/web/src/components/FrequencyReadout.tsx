"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

function format(khz: number) {
  return khz.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** What the user typed, as kHz rounded to 10 Hz, or null if it isn't a tunable frequency. */
export function parseFrequencyKhz(text: string): number | null {
  const value = Number(text.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(value) || value <= 0 || value > 30_000) return null;
  return Math.round(value * 100) / 100;
}

export function FrequencyReadout({ freqKhz, onChange }: { freqKhz: number; onChange: (khz: number) => void }) {
  const [draft, setDraft] = useState(format(freqKhz));
  const [editing, setEditing] = useState(false);
  const cancelling = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(format(freqKhz));
  }, [freqKhz, editing]);

  const commit = (e?: FormEvent) => {
    e?.preventDefault();
    const khz = parseFrequencyKhz(draft);
    if (khz !== null) onChange(khz);
    else setDraft(format(freqKhz));
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
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (cancelling.current) {
            cancelling.current = false;
            setDraft(format(freqKhz));
            setEditing(false);
          } else {
            commit();
          }
        }}
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
    </form>
  );
}
