"use client";

import { useEffect, useRef, useState } from "react";
import type { ScanState } from "@/lib/use-radio";

type Props = {
  scan: ScanState | null;
  /** The radio service can scan (an older one can't, and the list stays hidden). */
  canScan: boolean;
  /** A receiver is playing, so a scan can start. */
  listening: boolean;
  freqKhz: number;
  /** How long until the scan starts, from when the receiver started playing, for the note shown until then. */
  scanDelayMs: number;
  /** Pick best is still checking the receiver it chose, which the delay includes. */
  checking: boolean;
  onTune: (freqKhz: number) => void;
  onScanAgain: () => void;
};

const khz = (f: number) => f.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Rows a phone shows before "Show all"; wider screens show every row (CSS). */
export const PHONE_ROWS = 8;

/**
 * Strong broadcast signals on the receiver being listened to, from the radio
 * service's band scan. Ranked by how far each stands above the noise, which
 * says nothing about what's on: talk, music or a carrier with dead air.
 */
export function SignalList({ scan, canScan, listening, freqKhz, scanDelayMs, checking, onTune, onScanAgain }: Props) {
  // The scan whose whole list a phone asked for; a new scan starts short again.
  const [allFor, setAllFor] = useState<ScanState | null>(null);
  // "Show all" goes away when pressed; focus moves to the first row it revealed.
  const listRef = useRef<HTMLUListElement>(null);
  const revealing = useRef(false);
  useEffect(() => {
    if (!revealing.current) return;
    revealing.current = false;
    listRef.current?.querySelectorAll<HTMLButtonElement>(".preset-tune")[PHONE_ROWS]?.focus();
  }, [allFor]);
  if (!canScan || (!scan && !listening)) return null;
  // aria-disabled, not disabled: a disabled button drops keyboard focus, and
  // this one is pressed, then waits while its own scan runs.
  const busy = scan?.state === "scanning" || !listening;

  return (
    <section className="presets signals" aria-labelledby="signals-heading">
      <h2 id="signals-heading">Strong signals now</h2>
      {/* Only the text is announced; the button sits outside the live region. */}
      <div role="status">
        {!scan && (
          <p className="presets-note">
            {checking
              ? // Pick best's watch for a late refusal comes first, then the usual wait.
                `The broadcast bands get scanned once Pick best has finished checking this receiver, about ${Math.round(scanDelayMs / 1000)} seconds in.`
              : `The broadcast bands get scanned about ${Math.round(scanDelayMs / 1000)} seconds after a receiver starts playing.`}
          </p>
        )}
        {scan?.state === "scanning" && <p className="presets-note">Scanning this receiver's broadcast bands…</p>}
        {scan?.state === "error" && <p className="presets-note">{scan.message}</p>}
        {scan?.state === "done" && (
          <p className="presets-note">
            {scan.bandsTotal === 0
              ? // A receiver behind a converter can sit outside every broadcast band.
                "This receiver doesn't cover the broadcast bands."
              : scan.signals.length === 0
                ? "No strong broadcast signals right now."
                : "Strongest first, in AM."}
            {scan.partial && ` Scanned ${scan.bandsDone} of ${scan.bandsTotal} bands.`}
            {scan.hidden > 0 &&
              ` ${scan.hidden} digital or noise ${scan.hidden === 1 ? "signal isn't" : "signals aren't"} listed.`}
          </p>
        )}
      </div>
      {scan && (
        <button
          type="button"
          className="link-button signals-again"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onScanAgain();
          }}
        >
          Scan again
        </button>
      )}

      {scan?.state === "done" && scan.signals.length > 0 && (
        <ul
          ref={listRef}
          className={allFor === scan ? "presets-list signals-list signals-list-all" : "presets-list signals-list"}
        >
          {scan.signals.map((s, i) => (
            <li
              key={s.freqKhz}
              data-current={Math.abs(s.freqKhz - freqKhz) < 0.005 || undefined}
              data-beyond={i >= PHONE_ROWS || undefined}
            >
              <button type="button" className="preset-tune" onClick={() => onTune(s.freqKhz)}>
                <span className="preset-freq">{khz(s.freqKhz)}</span>
                <span className="preset-mode">{s.band}</span>
                <span className="signal-strength">{s.snrDb} dB above noise</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {scan?.state === "done" && scan.signals.length > PHONE_ROWS && allFor !== scan && (
        // Shown on phones only, where the list is one long column.
        <button
          type="button"
          className="link-button signals-more"
          onClick={() => {
            revealing.current = true;
            setAllFor(scan);
          }}
        >
          Show all {scan.signals.length}
        </button>
      )}
    </section>
  );
}
