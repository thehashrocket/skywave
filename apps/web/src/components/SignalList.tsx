"use client";

import { useEffect, useRef, useState } from "react";
import { MODE_LABELS, type Mode } from "@/lib/radio-types";
import type { HamDone, HamSignal, ScanState } from "@/lib/use-radio";

type Props = {
  scan: ScanState | null;
  /** The last finished amateur part for this receiver; kept through a refresh. */
  lastHam?: HamDone | null;
  /** The radio service can scan (an older one can't, and the list stays hidden). */
  canScan: boolean;
  /** It can scan the amateur bands too ("scan-ham"). */
  canScanHam?: boolean;
  /** A receiver is playing, so a scan can start. */
  listening: boolean;
  freqKhz: number;
  mode?: Mode;
  /** How long until the scan starts, from when the receiver started playing, for the note shown until then. */
  scanDelayMs: number;
  /** Pick best is still checking the receiver it chose, which the delay includes. */
  checking: boolean;
  onTune: (freqKhz: number, mode: Mode) => void;
  onScanAgain: () => void;
};

const khz = (f: number) => f.toLocaleString("en-US", { maximumFractionDigits: 2 });
/** Amateur dials to exactly 0.1 kHz; digital rows show their standard dial as is. */
const hamKhz = (s: HamSignal) =>
  s.label
    ? s.freqKhz.toLocaleString("en-US", { maximumFractionDigits: 1 })
    : s.freqKhz.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Rows a phone shows per section before "Show all"; wider screens show every row (CSS). */
export const PHONE_ROWS = 8;
/** An amateur list this old says it may be out of date (owner D8). */
export const HAM_STALE_MS = 2 * 60_000;
const AGE_TICK_MS = 15_000;

/** The amateur groups, in order; `phone` is each one's share of a phone's rows (owner D12). */
const GROUPS = [
  { key: "voice", title: "Voice", phone: 4, note: "Frequencies are estimates; nudge the dial if a voice sounds off." },
  { key: "cw", title: "CW", phone: 2, note: "Morse code." },
  {
    key: "digital",
    title: "Digital",
    phone: 2,
    note: "Data tones; you can hear them but skywave doesn't decode them.",
  },
] as const;

/** The Amateur section's state lines, shown under its heading and in the live summary. */
const HAM_TEXT = {
  scanning: "Scanning the amateur bands…",
  error: "Couldn't scan the amateur bands.",
  none: "No strong amateur signals right now.",
  uncovered: "This receiver doesn't cover the amateur bands.",
} as const;

const listClass = (all: boolean) => (all ? "presets-list signals-list signals-list-all" : "presets-list signals-list");

/** How many of each amateur group a phone shows: its share, with unused slots given to the others in order. */
export function phoneShown(counts: readonly number[]): number[] {
  const shown = counts.map((n, i) => Math.min(n, GROUPS[i]?.phone ?? 0));
  let spare = PHONE_ROWS - shown.reduce((a, b) => a + b, 0);
  return shown.map((n, i) => {
    const more = Math.min(spare, (counts[i] ?? 0) - n);
    spare -= more;
    return n + more;
  });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Strong signals on the receiver being listened to, from the radio service's
 * band scan: broadcast stations, then (when the service scans them) the
 * amateur bands grouped into voice, CW and digital. Ranked by how far each
 * stands above the noise, which says nothing about what's on.
 */
export function SignalList({
  scan,
  lastHam = null,
  canScan,
  canScanHam = false,
  listening,
  freqKhz,
  mode = "am",
  scanDelayMs,
  checking,
  onTune,
  onScanAgain,
}: Props) {
  // Which lists a phone asked to see whole: broadcast per scan request, the
  // amateur part per result. Both replies of one request keep them open.
  const [allBroadcast, setAllBroadcast] = useState<number | null>(null);
  const [allHam, setAllHam] = useState<HamDone | null>(null);
  // "Show all" goes away when pressed; focus moves to the first row it revealed, in its own section.
  const broadcastRef = useRef<HTMLDivElement>(null);
  const hamRef = useRef<HTMLDivElement>(null);
  const revealing = useRef<"broadcast" | "ham" | null>(null);
  useEffect(() => {
    const section = revealing.current === "broadcast" ? broadcastRef : revealing.current === "ham" ? hamRef : null;
    revealing.current = null;
    section?.current?.querySelector<HTMLButtonElement>("[data-beyond] .preset-tune")?.focus();
  }, [allBroadcast, allHam]);
  // The amateur list's age ticks outside every live region.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!lastHam) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, [lastHam]);

  if (!canScan || (!scan && !listening)) return null;
  const done = scan?.state === "done" ? scan : null;
  const hamPhase = done?.ham;
  const ham = lastHam && scan && lastHam.host === scan.host && lastHam.port === scan.port ? lastHam : null;
  // aria-disabled, not disabled: a disabled button drops keyboard focus, and
  // this one is pressed, then waits while its own scan (both passes) runs.
  const busy = scan?.state === "scanning" || hamPhase === "scanning" || !listening;
  const counts = GROUPS.map((g) => (ham ? ham[g.key].length : 0));
  const hamRows = counts.reduce((a, b) => a + b, 0);
  const hamNote =
    hamPhase === "scanning"
      ? HAM_TEXT.scanning
      : hamPhase === "error"
        ? HAM_TEXT.error
        : ham && hamRows === 0
          ? ham.bandsTotal === 0
            ? HAM_TEXT.uncovered
            : HAM_TEXT.none
          : null;
  const stale = ham !== null && now - ham.heardAtMs >= HAM_STALE_MS;
  const showHam = canScanHam && (ham !== null || hamPhase !== undefined);

  const bands = canScanHam ? "broadcast and amateur bands" : "broadcast bands";
  // The broadcast part's footnotes: in the summary for an older service (as
  // before amateur scanning), under the Broadcast heading otherwise.
  const footnotes = done
    ? [
        done.partial ? `Scanned ${done.bandsDone} of ${done.bandsTotal} bands.` : "",
        done.hidden > 0
          ? `${plural(done.hidden, "flat-topped broadcast signal (digital or noise) isn't", "flat-topped broadcast signals (digital or noise) aren't")} listed.`
          : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  let summary: string;
  if (!scan) {
    summary = checking
      ? // Pick best's watch for a late refusal comes first, then the usual wait.
        `The ${bands} get scanned once Pick best has finished checking this receiver, about ${Math.round(scanDelayMs / 1000)} seconds in.`
      : `The ${bands} get scanned about ${Math.round(scanDelayMs / 1000)} seconds after a receiver starts playing.`;
  } else if (scan.state === "scanning") {
    summary = "Scanning this receiver's broadcast bands…";
  } else if (scan.state === "error") {
    summary = scan.message;
  } else {
    summary =
      scan.bandsTotal === 0
        ? // A receiver behind a converter can sit outside every broadcast band.
          "This receiver doesn't cover the broadcast bands."
        : scan.signals.length === 0
          ? "No strong broadcast signals right now."
          : canScanHam
            ? `${plural(scan.signals.length, "broadcast signal", "broadcast signals")}.`
            : "Strongest first, in AM.";
    if (!canScanHam && footnotes) summary += ` ${footnotes}`;
    if (hamPhase === "done" && ham && hamRows > 0) {
      summary += ` Amateur: ${ham.voice.length} voice, ${ham.cw.length} CW, ${ham.digital.length} digital.`;
    } else if (hamPhase !== undefined && hamNote) summary += ` ${hamNote}`;
    if (stale) summary += " Amateur list may be out of date.";
  }

  const isCurrent = (f: number, m: Mode) => Math.abs(f - freqKhz) < 0.005 && m === mode;
  type Row = { freqKhz: number; mode: Mode; shown: string; tag: string; snrDb: number; beyond: boolean };
  const row = ({ freqKhz: f, mode: m, shown, tag, snrDb, beyond }: Row) => {
    const current = isCurrent(f, m);
    return (
      <li key={`${f}-${m}`} data-current={current || undefined} data-beyond={beyond || undefined}>
        <button type="button" className="preset-tune" aria-current={current || undefined} onClick={() => onTune(f, m)}>
          <span className="preset-freq">{shown}</span>
          <span className="preset-mode">{tag}</span>
          <span className="signal-strength">
            {current ? "Tuned · " : ""}
            {snrDb} dB above noise
          </span>
        </button>
      </li>
    );
  };

  const broadcastAll = done !== null && allBroadcast === done.id;
  const hamAll = ham !== null && allHam === ham;
  const shown = phoneShown(counts);
  const hamBeyond = hamRows - shown.reduce((a, b) => a + b, 0);

  return (
    <section className="presets signals" aria-labelledby="signals-heading">
      <h2 id="signals-heading">Strong signals now</h2>
      <p className="presets-note signals-status">
        {/* Summaries only are announced: the age and the lists sit outside it. */}
        <span role="status">{summary}</span>
        {hamPhase === "done" && hamRows > 0 && (
          <>
            {" "}
            <a className="signals-jump" href="#signals-amateur">
              Amateur: {hamRows} found below
            </a>
          </>
        )}
      </p>
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

      {done && done.signals.length > 0 && (
        <div ref={broadcastRef}>
          {canScanHam && <h3 className="signals-section">Broadcast</h3>}
          {canScanHam && <p className="presets-note">Strongest first, in AM.{footnotes && ` ${footnotes}`}</p>}
          <ul className={listClass(broadcastAll)}>
            {done.signals.map((s, i) =>
              row({ ...s, mode: "am", shown: khz(s.freqKhz), tag: s.band, beyond: i >= PHONE_ROWS }),
            )}
          </ul>
          {done.signals.length > PHONE_ROWS && !broadcastAll && (
            // Shown on phones only, where the list is one long column.
            <button
              type="button"
              className="link-button signals-more"
              onClick={() => {
                revealing.current = "broadcast";
                setAllBroadcast(done.id);
              }}
            >
              Show all {done.signals.length} broadcast
            </button>
          )}
        </div>
      )}
      {canScanHam && done && done.signals.length === 0 && footnotes && <p className="presets-note">{footnotes}</p>}

      {showHam && (
        <div ref={hamRef} className="signals-ham" data-all={hamAll || undefined}>
          <h3 id="signals-amateur" className="signals-section signals-section-amateur">
            Amateur
            {ham && (
              <span className="signals-age" data-old={stale || undefined}>
                {now - ham.heardAtMs < 60_000
                  ? "Just now"
                  : `Heard ${Math.floor((now - ham.heardAtMs) / 60_000)} min ago`}
                {stale && " · may be out of date"}
              </span>
            )}
          </h3>
          <div className="signals-ham-body" data-scanning={(hamPhase === "scanning" && !ham) || undefined}>
            {hamNote && <p className="presets-note">{hamNote}</p>}
            {ham && hamRows > 0 && (
              <p className="presets-note">
                Hams use far less power than broadcasters, so these read lower.
                {ham.partial && ` Scanned ${ham.bandsDone} of ${ham.bandsTotal} amateur bands.`}
              </p>
            )}
            {ham &&
              GROUPS.map((g, gi) => {
                const signals = ham[g.key];
                if (signals.length === 0) return null;
                return (
                  <div key={g.key} className="signals-group" data-beyond={(shown[gi] ?? 0) === 0 || undefined}>
                    <h4>{g.title}</h4>
                    <p className="presets-note">{g.note}</p>
                    <ul className={listClass(hamAll)}>
                      {signals.map((s, i) =>
                        row({
                          ...s,
                          shown: hamKhz(s),
                          tag: `${s.band} ${s.label ?? MODE_LABELS[s.mode]}`,
                          beyond: i >= (shown[gi] ?? 0),
                        }),
                      )}
                    </ul>
                  </div>
                );
              })}
            {ham && hamBeyond > 0 && !hamAll && (
              <button
                type="button"
                className="link-button signals-more"
                onClick={() => {
                  revealing.current = "ham";
                  setAllHam(ham);
                }}
              >
                Show all {hamRows} amateur
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
