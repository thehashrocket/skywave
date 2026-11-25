"use client";

import { useEffect, useRef } from "react";
import type { DecodeState } from "@/lib/use-radio";

function statusLine(state: DecodeState, canDecode: boolean, playing: boolean): string {
  if (state.state === "error") return state.message ?? "The decoder stopped.";
  if (!playing) return "Decodes RTTY (45.45 baud, 170 Hz shift) once a receiver plays.";
  if (!canDecode) return "This radio service can't decode RTTY yet.";
  if (state.state === "locked" && state.markHz !== undefined) {
    return `Decoding. Mark tone at ${Math.round(state.markHz)} Hz.`;
  }
  return "Looking for RTTY tones (45.45 baud, 170 Hz shift)…";
}

/**
 * Text decoded from the signal being played, under the waterfall. Shown only
 * while a decoder is on (or has just failed). Follows the newest text unless
 * the listener has scrolled up to read.
 */
export function DecodePanel({
  state,
  text,
  canDecode,
  playing,
  onReverse,
  onClear,
  onOff,
}: {
  state: DecodeState;
  text: string;
  canDecode: boolean;
  playing: boolean;
  onReverse: () => void;
  onClear: () => void;
  onOff: () => void;
}) {
  const logRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const el = logRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <section className="decode-panel" aria-label="Decoded RTTY">
      <div className="decode-head">
        <span className="decode-title">RTTY</span>
        <span role="status">
          {statusLine(state, canDecode, playing)}
        </span>
        <span className="decode-actions">
          {state.state !== "error" && (
            <button
              type="button"
              className="decode-button"
              aria-pressed={state.reverse}
              title="Swap mark and space, for stations sending the other way round"
              onClick={onReverse}
            >
              Reverse
            </button>
          )}
          <button type="button" className="decode-button" onClick={onClear} disabled={text === ""}>
            Clear
          </button>
          <button type="button" className="decode-button" onClick={onOff}>
            {state.state === "error" ? "Close" : "Turn off"}
          </button>
        </span>
      </div>
      <pre
        ref={logRef}
        className="decode-text"
        tabIndex={0}
        aria-label="Decoded text"
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        }}
      >
        {text}
      </pre>
    </section>
  );
}
