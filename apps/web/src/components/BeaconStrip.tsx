"use client";

import { Fragment, type ReactNode } from "react";
import { beaconOnBand, IBP_BANDS_KHZ, msLeftInSlot } from "@/lib/ibp";
import { beaconWatch, formatCountdown, noQuestionReason, type BeaconPick, type BeaconWatch } from "@/lib/reception";
import { useServerTick } from "@/lib/use-server-tick";

type Props = {
  /** Beacon mode: the strip is open, and the map shows the beacons. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The band the dial is on, into IBP_BANDS_KHZ; -1 for none. */
  tunedBand: number;
  /** The beacon picked with Listen, if any, and when (server time). */
  pick: (BeaconPick & { atMs?: number }) | null;
  /** When audio started on the picked beacon's channel (server time), or null for none yet. */
  audioStartMs?: number | null;
  /** The picked beacon's turn the reception prompt plans to ask about (server time), null for none. */
  askSlotMs?: number | null;
  /** The listener closed enough questions that none are asked in this tab. */
  questionsOff?: boolean;
  /** A receiver is being tuned or connected, with no audio from it yet. */
  connecting?: boolean;
  onListen: (bandIndex: number) => void;
  /**
   * The reception prompt (or its thanks) about a beacon, shown in a row of its
   * own directly under band `promptBand`'s row instead of under the status line.
   */
  prompt?: ReactNode;
  promptBand?: number;
};

const SECOND = 1_000;

/** The strip's summary: where focus goes when the strip is opened from elsewhere, or its prompt goes away. */
export function focusBeaconStrip() {
  const summary = document.querySelector<HTMLElement>(".beacons > summary");
  summary?.scrollIntoView?.({ block: "nearest" });
  summary?.focus();
}

/** The line about the picked beacon: when it's next on, that it's on now, or that its first turn was missed. */
export function watchText(w: BeaconWatch): { text: string; countdown?: string; after?: string } {
  if (w.state === "on-air") return { text: `${w.call} on air now. Listen for the callsign, then four dashes.` };
  const countdown = formatCountdown(w.inMs);
  return w.state === "missed"
    ? { text: `Missed the start; ${w.call} is back in `, countdown, after: "." }
    : { text: `Listening for ${w.call}: next on ${(w.bandKhz / 1000).toFixed(3)} in `, countdown };
}

/**
 * The row under a band's row: the reception prompt about that band (or its
 * thanks), else the line about the picked beacon. The prompt's region is
 * always rendered, empty when there's none, so a screen reader hears it when
 * it appears (as on the status line). The picked-beacon line sits outside it:
 * its countdown changes every second. A hidden live line says only when the
 * state changes (waiting, on air, missed).
 */
function PromptRow({
  prompt,
  watch,
  why,
}: {
  prompt: ReactNode;
  watch: BeaconWatch | null;
  /** Why no question will follow the turn the line is about, if none will. */
  why: NoQuestion;
}) {
  const line = !prompt && watch ? watchText(watch) : null;
  const note = why && NO_QUESTION[why];
  // For the hidden live line, as a sentence.
  const spoken = note && `${note[0]!.toUpperCase()}${note.slice(1)}${note.endsWith("…") ? "" : "."}`;
  return (
    <tr className="beacons-prompt">
      <td colSpan={3} data-filled={prompt || line ? true : undefined}>
        {line && (
          <p className="beacons-watch" data-state={watch!.state}>
            {line.text}
            {line.countdown && <span className="beacons-countdown">{line.countdown}</span>}
            {note && <span className="beacons-no-question"> · {note}</span>}
            {line.after}
          </p>
        )}
        <div className="beacons-prompt-line" role="status">
          {prompt}
          {line && (
            <span className="visually-hidden">
              {stateWords(watch!)}
              {spoken && ` ${spoken}`}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

type NoQuestion = ReturnType<typeof noQuestionReason>;

/**
 * What the line adds when no question will follow the turn it's about, or,
 * while the receiver is still connecting, that it is: whether a question will
 * come isn't known until audio starts.
 */
const NO_QUESTION: Record<NonNullable<NoQuestion>, string> = {
  none: "no question this time",
  off: "questions are off in this tab",
  connecting: "Connecting…",
};

/** What the hidden live line says: the state, without the countdown. */
function stateWords(w: BeaconWatch): string {
  if (w.state === "on-air") return `${w.call} on air now.`;
  return w.state === "missed" ? `Missed the start of ${w.call}.` : `Listening for ${w.call}.`;
}

/**
 * The IBP band strip (issue #59): the five beacon frequencies, the beacon on
 * each now by the server-corrected clock, and when they next change. Listen
 * on a row tunes that frequency in CW and picks a receiver placed to hear
 * that beacon. Open is beacon mode: the map shows the beacons too.
 */
export function BeaconStrip({
  open,
  onOpenChange,
  tunedBand,
  pick,
  audioStartMs = null,
  askSlotMs = null,
  questionsOff = false,
  connecting = false,
  onListen,
  prompt,
  promptBand = -1,
}: Props) {
  // Every second while open, for the countdowns; the rows change with it on each 10 s boundary.
  const now = useServerTick(SECOND, open);
  const watch =
    pick?.atMs !== undefined && now !== null
      ? beaconWatch({ pick, pickedAtMs: pick.atMs, audioStartMs, nowMs: now })
      : null;
  const why = watch && noQuestionReason(watch.turnStartMs, askSlotMs, questionsOff, connecting);

  return (
    <details className="beacons" open={open} onToggle={(e) => onOpenChange(e.currentTarget.open)}>
      <summary>IBP beacons</summary>
      {now !== null && (
        <>
          <p className="beacons-head">
            On air now <span className="beacons-next">· next change in {Math.ceil(msLeftInSlot(now) / SECOND)} s</span>
          </p>
          <table className="beacons-strip">
            <caption className="visually-hidden">The beacon on each IBP frequency now</caption>
            <tbody>
              {IBP_BANDS_KHZ.map((khz, b) => {
                const beacon = beaconOnBand(now, b);
                // The picked beacon stays marked as it moves up the bands; Listen is pressed only on its own band.
                const picked = pick?.call === beacon.call;
                return (
                  <Fragment key={khz}>
                    <tr data-current={tunedBand === b || undefined} data-picked={picked || undefined}>
                      <th scope="row" className="beacons-freq">
                        {(khz / 1000).toFixed(3)}
                      </th>
                      <td className="beacons-call">
                        {beacon.call} <span className="beacons-place">{beacon.location}</span>
                        {picked && <span className="beacons-picked"> · picked</span>}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="link-button inline"
                          aria-label={`Listen to ${beacon.call} on ${(khz / 1000).toFixed(3)} MHz`}
                          aria-pressed={picked && pick?.bandIndex === b}
                          onClick={(e) => {
                            if (e.detail <= 1) onListen(b);
                          }}
                        >
                          Listen
                        </button>
                      </td>
                    </tr>
                    <PromptRow
                      prompt={promptBand === b ? prompt : null}
                      watch={watch && pick?.bandIndex === b ? watch : null}
                      why={why}
                    />
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <p className="beacons-note">
            Each beacon sends its callsign, then four 1-second dashes at 100 W, 10 W, 1 W and 100 mW: hear the last dash
            and the path is wide open.
          </p>
          <p className="beacons-note">
            By the UTC clock; the receiver&apos;s audio runs a second or two behind, and a beacon may be off the air.
            Each moves up a band every 10 seconds.
          </p>
        </>
      )}
    </details>
  );
}
