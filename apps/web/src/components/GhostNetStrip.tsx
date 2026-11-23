"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import {
  ALE_CHANNELS_KHZ,
  followingSlot,
  formatWait,
  isTuned,
  KIND_LABELS,
  listenOffered,
  localLabel,
  mhz,
  stripRows,
  utcDay,
  utcLabel,
  utcSpan,
  type Occurrence,
  type SlotKind,
} from "@/lib/ghostnet";
import { MODE_LABELS, type Mode } from "@/lib/radio-types";
import { useServerTick } from "@/lib/use-server-tick";

/** The net or bridge a GhostNet Listen picked, and when that window ends (Unix ms, eventEnd). */
export type GhostPick = { eventId: string; endMs: number };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the dial is, for the tuned marker and note (owner D12). */
  freqKhz: number;
  mode: Mode;
  /** The net whose Listen was pressed, while the dial stays where it tuned. */
  pick: GhostPick | null;
  /** A receiver is being tuned or connected, with no audio from it yet (D8). */
  connecting?: boolean;
  /** Audio is playing. */
  playing?: boolean;
  onListen: (o: Occurrence) => void;
};

const SECOND = 1_000;
const MINUTE = 60_000;
const S2_URL = "https://github.com/s2underground/GhostNet";

/**
 * What a tuned on-air row says the audio will be (owner D4, D14): no promise
 * of a decoder, no issue numbers.
 */
const KIND_NOTES: Record<SlotKind, string> = {
  js8: "JS8Call data: you'll hear tones. Skywave can't decode them yet.",
  rtty: "RTTY at 45.45 baud: you'll hear two-tone data. Skywave can't decode it yet.",
  vara: "Can't be decoded here.",
  ale: "Can't be decoded here.",
  voice: "Emergency voice only; usually silent.",
};

/** The strip's open focus target, like focusBeaconStrip. */
export function focusGhostNetStrip() {
  const summary = document.querySelector<HTMLElement>(".ghostnet > summary");
  summary?.scrollIntoView?.({ block: "nearest" });
  summary?.focus();
}

/** Listen's accessible name (owner D15): net, kind, the guide's frequency, and the dial when it differs. */
export function listenLabel(o: Occurrence): string {
  const { guideKhz, dialKhz, mode, kind } = o.slot;
  const what = `Listen to ${o.event.name}, ${KIND_LABELS[kind]} on ${mhz(guideKhz!)} MHz`;
  const band = MODE_LABELS[mode!];
  return dialKhz === guideKhz ? `${what} ${band}` : `${what}, dial ${mhz(dialKhz!, 4)} ${band}`;
}

/** The line under an on-air row's name: "Connecting…" for the picked row, else what its audio is. */
function noteFor(o: Occurrence, tuned: boolean, picked: boolean, connecting: boolean): string | null {
  if (picked && connecting) return "Connecting…";
  if (o.slot.kind === "ale") {
    const channels = ALE_CHANNELS_KHZ.map((k) => mhz(k, 4)).join(", ");
    return `Hops ${ALE_CHANNELS_KHZ.length} USB channels: ${channels} MHz. ${KIND_NOTES.ale}`;
  }
  return tuned ? KIND_NOTES[o.slot.kind] : null;
}

/**
 * The GhostNet strip (issue #91): S2 Underground's weekly nets and bridges,
 * what's on the air now, and when each opens next. Listen on a row tunes it
 * and picks a receiver in the net's region; it shows only from 15 minutes
 * before a window opens (owner D9).
 */
export function GhostNetStrip({ open, onOpenChange, freqKhz, mode, pick, connecting = false, playing = false, onListen }: Props) {
  // The folded summary's status, once a minute (D6); the body's countdowns every second while open.
  const minute = useServerTick(MINUTE);
  const now = useServerTick(SECOND, open);
  const summaryAt = now ?? minute;
  const announce = useAnnouncements(now, pick, connecting, playing);

  let tail: string | null = null;
  if (summaryAt !== null) {
    const { onNow, next } = stripRows(summaryAt);
    if (onNow[0]) tail = `${onNow[0].event.name} on now`;
    else if (next[0]) tail = `next in ${formatWait(next[0].startMs - summaryAt, false)}`;
  }

  return (
    <details className="ghostnet" open={open} onToggle={(e) => onOpenChange(e.currentTarget.open)}>
      <summary>
        GhostNet
        {tail && (
          <span className="ghostnet-tail" aria-hidden="true">
            {" "}
            · {tail}
          </span>
        )}
      </summary>
      <p className="ghostnet-about">
        A volunteer HF radio network on a fixed weekly schedule, mostly JS8Call text messages. GhostNet schedule by{" "}
        <a href={S2_URL} target="_blank" rel="noreferrer">
          S2 Underground
        </a>
        .
      </p>
      {now !== null && (
        <Body
          now={now}
          freqKhz={freqKhz}
          mode={mode}
          pick={pick}
          connecting={connecting}
          playing={playing}
          onListen={onListen}
        />
      )}
      <div className="visually-hidden" role="status">
        {announce}
      </div>
    </details>
  );
}

type BodyProps = Omit<Props, "open" | "onOpenChange" | "playing" | "connecting"> & {
  now: number;
  connecting: boolean;
  playing: boolean;
};

function Body({ now, freqKhz, mode, pick, connecting, playing, onListen }: BodyProps) {
  const { onNow, next } = stripRows(now);
  const first = next[0];
  const tuned = (o: Occurrence) => isTuned(o.slot, freqKhz, mode);
  // The picked net's row while the dial is on its slot (C1: a net rolling into a slot on the same dial stays picked).
  // Not past its window, so next week's row of the same net never reads as picked (review D5).
  const picked = (o: Occurrence) => pick?.eventId === o.event.id && now < pick.endMs && tuned(o);
  // A receiver is connecting or playing for this run, so re-pressing its Listen could cut it (D9).
  const busy = connecting || playing;
  const row = { now, tuned, picked, busy, onListen };

  return (
    <>
      <p className="sched-head">On now</p>
      {onNow.length === 0 ? (
        <p className="ghostnet-empty">
          Nothing on the air now.
          {first && ` Next: ${first.event.name}, ${utcLabel(first.startMs)} (in ${formatWait(first.startMs - now)}).`}
        </p>
      ) : (
        <table className="sched-strip" role="table">
          <caption className="visually-hidden">GhostNet windows on the air now</caption>
          <tbody role="rowgroup">
            {onNow.map((o) => {
              const after = followingSlot(o);
              const note = noteFor(o, tuned(o), picked(o), connecting);
              return (
                <Fragment key={o.event.id}>
                  <Row
                    o={o}
                    {...row}
                    utc={`${KIND_LABELS[o.slot.kind]} · ${utcDay(o.startMs)} ${utcSpan(o)}`}
                    wait={`${formatWait(o.endMs - now)} left`}
                  />
                  {(note || after) && (
                    <tr className="ghostnet-note-row" role="row">
                      <td colSpan={3} role="cell">
                        {note && <span className="ghostnet-note">{note}</span>}
                        {after && (
                          <span className="sched-place ghostnet-after">
                            Next slot: {KIND_LABELS[after.slot.kind]}
                            {after.slot.guideKhz !== null && `, ${mhz(after.slot.guideKhz)}`}, in{" "}
                            {formatWait(after.startMs - now)}
                          </span>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="sched-head">Next</p>
      <table className="sched-strip" role="table">
        <caption className="visually-hidden">When each GhostNet net and bridge opens next</caption>
        <tbody role="rowgroup">
          {next.map((o) => (
            <Row key={o.event.id} o={o} {...row} utc={utcLabel(o.startMs)} wait={`in ${formatWait(o.startMs - now)}`} />
          ))}
        </tbody>
      </table>
      <p className="sched-note">
        Times are UTC; local times follow your device clock. Outside a window these frequencies are usually quiet.
      </p>
    </>
  );
}

/** One slot's row: frequency, the net with its UTC and local times, and the wait with Listen when offered. */
function Row({
  o,
  now,
  tuned,
  picked,
  busy,
  onListen,
  utc,
  wait,
}: {
  o: Occurrence;
  now: number;
  tuned: (o: Occurrence) => boolean;
  picked: (o: Occurrence) => boolean;
  busy: boolean;
  onListen: (o: Occurrence) => void;
  utc: string;
  wait: string;
}) {
  const { guideKhz, mode } = o.slot;
  return (
    // Explicit roles: on phones the rows are laid out as a grid (review D6), which can drop a
    // table's implicit semantics in some browsers.
    <tr role="row" data-current={tuned(o) || undefined} data-picked={picked(o) || undefined}>
      <th scope="row" role="rowheader" className="sched-freq">
        {guideKhz === null || mode === null ? (
          "ALE"
        ) : (
          <>
            {mhz(guideKhz)} <span className="ghostnet-mode">{MODE_LABELS[mode]}</span>
          </>
        )}
      </th>
      <td role="cell">
        <span className="ghostnet-name">{o.event.name}</span>
        {/* UTC, then the device's local time with weekday and zone (D16, D17); phones stack them (D12). */}
        <span className="sched-place ghostnet-when">
          <span>{utc}</span>
          <span className="ghostnet-local">
            <span className="ghostnet-sep"> · </span>
            {localLabel(o.startMs)}
          </span>
        </span>
      </td>
      <td role="cell">
        <span className="sched-next ghostnet-wait">{wait}</span>
        {listenOffered(o, now) && (
          <button
            type="button"
            className="link-button inline"
            aria-label={listenLabel(o)}
            aria-pressed={picked(o)}
            onClick={(e) => {
              // Pressing the picked row's Listen again while it connects or plays would restart Pick
              // best and could cut the audio (review D9); after Stop or a failed start it listens again.
              if (e.detail <= 1 && !(picked(o) && busy)) onListen(o);
            }}
          >
            Listen
          </button>
        )}
      </td>
    </tr>
  );
}

/**
 * What the hidden status line says (owner D13): only changes, never the
 * ticking countdowns. A window starting or ending, and the picked net
 * connecting or playing. Reopening the strip only records; it says nothing.
 */
function useAnnouncements(now: number | null, pick: GhostPick | null, connecting: boolean, playing: boolean): string {
  const [text, setText] = useState("");
  const last = useRef<{ names: Map<string, string>; picked: string } | null>(null);
  const picked = pick ? `${pick.eventId}:${connecting ? "connecting" : playing ? "playing" : ""}` : "";

  useEffect(() => {
    if (now === null) {
      last.current = null;
      return;
    }
    const names = new Map(stripRows(now).onNow.map((o) => [o.event.id, o.event.name]));
    const prev = last.current;
    last.current = { names, picked };
    if (!prev) return;
    const lines: string[] = [];
    for (const [id, name] of names) if (!prev.names.has(id)) lines.push(`${name} on the air now.`);
    for (const [id, name] of prev.names) if (!names.has(id)) lines.push(`${name} ended.`);
    if (pick && picked !== prev.picked) {
      if (connecting) lines.push("Connecting…");
      else if (playing && names.has(pick.eventId)) lines.push(`${names.get(pick.eventId)} playing.`);
    }
    if (lines.length) setText(lines.join(" "));
  }, [now, pick, picked, connecting, playing]);

  return text;
}
