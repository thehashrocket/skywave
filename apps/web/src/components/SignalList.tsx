"use client";

import type { ScanState } from "@/lib/use-radio";

type Props = {
  scan: ScanState | null;
  /** The radio service can scan (an older one can't, and the list stays hidden). */
  canScan: boolean;
  /** A receiver is playing, so a scan can start. */
  listening: boolean;
  freqKhz: number;
  /** How long a receiver plays before its scan starts, for the note shown until then. */
  autoScanMs: number;
  onTune: (freqKhz: number) => void;
  onScanAgain: () => void;
};

const khz = (f: number) => f.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * Strong broadcast signals on the receiver being listened to, from the radio
 * service's band scan. Ranked by how far each stands above the noise, which
 * says nothing about what's on: talk, music or a carrier with dead air.
 */
export function SignalList({ scan, canScan, listening, freqKhz, autoScanMs, onTune, onScanAgain }: Props) {
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
            The broadcast bands get scanned about {Math.round(autoScanMs / 1000)} seconds after a receiver starts
            playing.
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
        <ul className="presets-list signals-list">
          {scan.signals.map((s) => (
            <li key={s.freqKhz} data-current={Math.abs(s.freqKhz - freqKhz) < 0.005 || undefined}>
              <button type="button" className="preset-tune" onClick={() => onTune(s.freqKhz)}>
                <span className="preset-freq">{khz(s.freqKhz)}</span>
                <span className="preset-mode">{s.band}</span>
                <span className="signal-strength">{s.snrDb} dB above noise</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
