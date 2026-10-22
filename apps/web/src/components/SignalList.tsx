"use client";

import type { ScanState } from "@/lib/use-radio";

type Props = {
  scan: ScanState | null;
  /** The radio service can scan (an older one can't, and the list stays hidden). */
  canScan: boolean;
  /** A receiver is playing, so a scan can start. */
  listening: boolean;
  freqKhz: number;
  onTune: (freqKhz: number) => void;
  onScanAgain: () => void;
};

const khz = (f: number) => f.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * Strong broadcast signals on the receiver being listened to, from the radio
 * service's band scan. Ranked by how far each stands above the noise, which
 * says nothing about what's on: talk, music or a carrier with dead air.
 */
export function SignalList({ scan, canScan, listening, freqKhz, onTune, onScanAgain }: Props) {
  if (!canScan || (!scan && !listening)) return null;
  const again = (
    <button type="button" className="link-button inline" onClick={onScanAgain} disabled={!listening}>
      Scan again
    </button>
  );

  return (
    <section className="presets signals" aria-labelledby="signals-heading">
      <h2 id="signals-heading">Strong signals now</h2>
      <div role="status">
        {!scan && (
          <p className="presets-note">
            The broadcast bands get scanned about 10 seconds after a receiver starts playing.
          </p>
        )}
        {scan?.state === "scanning" && <p className="presets-note">Scanning this receiver's broadcast bands…</p>}
        {scan?.state === "error" && (
          <p className="presets-note">
            {scan.message} {again}
          </p>
        )}
        {scan?.state === "done" && (
          <p className="presets-note">
            {scan.signals.length === 0 ? "No strong broadcast signals right now." : "Strongest first, in AM."}
            {scan.partial && ` Scanned ${scan.bandsDone} of ${scan.bandsTotal} bands before the time limit.`}
            {scan.hidden > 0 &&
              ` ${scan.hidden} digital or noise ${scan.hidden === 1 ? "signal isn't" : "signals aren't"} listed.`}{" "}
            {again}
          </p>
        )}
      </div>

      {scan?.state === "done" && scan.signals.length > 0 && (
        <ul className="presets-list">
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
