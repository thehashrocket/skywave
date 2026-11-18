"use client";

import { Fragment, type ReactNode } from "react";
import { beaconOnBand, IBP_BANDS_KHZ, msLeftInSlot } from "@/lib/ibp";
import type { BeaconPick } from "@/lib/reception";
import { useServerTick } from "@/lib/use-server-tick";

type Props = {
  /** Beacon mode: the strip is open, and the map shows the beacons. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The band the dial is on, into IBP_BANDS_KHZ; -1 for none. */
  tunedBand: number;
  /** The beacon picked with Listen, if any. */
  pick: BeaconPick | null;
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

/**
 * The IBP band strip (issue #59): the five beacon frequencies, the beacon on
 * each now by the server-corrected clock, and when they next change. Listen
 * on a row tunes that frequency in CW and picks a receiver placed to hear
 * that beacon. Open is beacon mode: the map shows the beacons too.
 */
export function BeaconStrip({ open, onOpenChange, tunedBand, pick, onListen, prompt, promptBand = -1 }: Props) {
  // Every second while open, for the countdown; the rows change with it on each 10 s boundary.
  const now = useServerTick(SECOND, open);

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
                const picked = pick?.bandIndex === b && pick.call === beacon.call;
                return (
                  <Fragment key={khz}>
                    <tr data-current={tunedBand === b || undefined}>
                      <th scope="row" className="beacons-freq">
                        {(khz / 1000).toFixed(3)}
                      </th>
                      <td className="beacons-call">
                        {beacon.call} <span className="beacons-place">{beacon.location}</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="link-button inline"
                          aria-label={`Listen to ${beacon.call} on ${(khz / 1000).toFixed(3)} MHz`}
                          aria-pressed={picked}
                          onClick={(e) => {
                            if (e.detail <= 1) onListen(b);
                          }}
                        >
                          Listen
                        </button>
                      </td>
                    </tr>
                    {/* Always rendered, empty unless the prompt is about this band, so a
                      screen reader hears it when it appears (as on the status line). */}
                    <tr className="beacons-prompt">
                      <td colSpan={3}>
                        <div className="beacons-prompt-line" role="status">
                          {promptBand === b ? prompt : null}
                        </div>
                      </td>
                    </tr>
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
