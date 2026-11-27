"use client";

import { SectionBody, SectionHeading } from "@/components/SectionHeading";
import type { Fold } from "@/lib/section-folds";
import { useEffect, useRef, useState } from "react";
import { formatWait } from "@/lib/ghostnet";
import { PRIYOM_ON_AIR_MS, PRIYOM_SCHEDULE_PAGE, type PriyomTx } from "@/lib/priyom-schedule";
import type { Mode } from "@/lib/radio-types";
import { heardText, type LastHeard } from "@/lib/signal-heard";
import { channelParts, channelText } from "@/lib/signal-page";
import { onKhz, panelGroups, type PanelGroups, type PanelRow } from "@/lib/signal-panel";
import type { SignalCategory, SignalChannel, SignalStation, SlugRow } from "@/lib/signal-stations";
import { localLabel, utcLabel } from "@/lib/utc-time";
import { useServerTick } from "@/lib/use-server-tick";

const MINUTE = 60_000;

const CATEGORY_LABELS: Record<SignalCategory, string> = {
  numbers: "Numbers",
  time: "Time signal",
  marker: "Marker",
  military: "Military",
  other: "Other",
};

type Props = {
  /** Folding this section (collapsible sections); without it the heading is a plain h2. */
  fold?: Fold;
  /** Where the dial is, for the tuned marker. */
  freqKhz: number;
  mode: Mode;
  /** Priyom's schedule for the numbers stations; null while the server has none. */
  priyom: readonly PriyomTx[] | null;
  /**
   * The merged schedule the dial reads (on-air.ts): the day/night stations' switch
   * times (#168). Null while it loads (those rows hold their Listen); undefined when
   * there's none to be had (they follow the sun).
   */
  schedule?: readonly SlugRow[] | null;
  /** When listeners last heard each station, by slug (signals.lastHeard, #102); null for no badges. */
  heard?: Record<string, LastHeard> | null;
  /** The station a Listen or a shared link picked (its slug), while the dial stays on it. */
  picked: string | null;
  /** A receiver is being tuned or connected for that pick, with no audio yet. */
  connecting?: boolean;
  /** Audio is playing. */
  playing?: boolean;
  onListen: (station: SignalStation, channel: SignalChannel) => void;
};

/** The panel's heading, where a shared link with a station brings the page (#100). */
export function focusSignalStations() {
  document.getElementById("signal-stations-heading")?.scrollIntoView?.({ block: "start" });
}


/** Listen's accessible name: station and what it tunes. */
function listenLabel(station: SignalStation, ch: SignalChannel): string {
  return `Listen to ${station.name} on ${channelText(ch)}`;
}

/**
 * The Signal stations panel (issue #100): time signals, markers and numbers
 * stations, grouped as on now, up next, always on, later, and history. Listen
 * on a row tunes the station and runs Pick best ranked by its path
 * (lib/signal-rank.ts); it shows only when there's something on the air to
 * tune, so it never lands in a schedule's silence, and never for a station
 * that's off the air for good.
 */
export function SignalStations({
  fold,
  freqKhz,
  mode,
  priyom,
  schedule,
  heard = null,
  picked,
  connecting = false,
  playing = false,
  onListen,
}: Props) {
  const now = useServerTick(MINUTE);
  const groups = now === null ? null : panelGroups(now, priyom, schedule);
  const announce = useAnnouncements(groups?.onNow ?? null, picked, freqKhz, connecting, playing);
  // While folded: what's on the air (collapsible sections).
  let foldTail: string | null = null;
  if (groups?.onNow[0]) {
    const more = groups.onNow.length - 1;
    foldTail = `${groups.onNow[0].station.name} on now${more > 0 ? ` +${more} more` : ""}`;
  } else if (groups) foldTail = `${groups.always.length} always on`;
  return (
    <section className="presets signals" aria-labelledby="signal-stations-heading">
      <SectionHeading section="signal-stations" fold={fold} tail={foldTail}>
        Signal stations
      </SectionHeading>
      <SectionBody section="signal-stations" fold={fold}>
        <p className="signals-about">
          Time signals, markers and numbers stations: the oddities people tune shortwave to find.
        </p>
        {now !== null && groups && (
          <Groups
            groups={groups}
            now={now}
            freqKhz={freqKhz}
            mode={mode}
            priyom={priyom}
            heard={heard}
            picked={picked}
            busy={connecting || playing}
            onListen={onListen}
          />
        )}
        <p className="sched-note">
          Numbers-station schedules from{" "}
          <a href={PRIYOM_SCHEDULE_PAGE} target="_blank" rel="noreferrer">
            Priyom.org
          </a>{" "}
          (CC BY-NC-SA 4.0). Priyom lists start times only, so a transmission counts as on for{" "}
          {PRIYOM_ON_AIR_MS / MINUTE} minutes from its start. Times are UTC; local times follow your device clock.
        </p>
      </SectionBody>
      {/* Outside the fold: the picked station's lines are still spoken while the section is folded. */}
      <div className="visually-hidden" role="status">
        {announce}
      </div>
    </section>
  );
}


type RowProps = {
  now: number;
  freqKhz: number;
  mode: Mode;
  priyom: readonly PriyomTx[] | null;
  heard: Record<string, LastHeard> | null;
  picked: string | null;
  busy: boolean;
  onListen: Props["onListen"];
};

function Groups({ groups: g, now, freqKhz, mode, priyom, heard, picked, busy, onListen }: { groups: PanelGroups } & RowProps) {
  const rowProps = { now, freqKhz, mode, priyom, heard, picked, busy, onListen };
  return (
    <>
      {g.onNow.length > 0 && <Group title="On now" caption="Signal stations on the air now" rows={g.onNow} {...rowProps} />}
      {g.upNext.length > 0 && <Group title="Up next" caption="Starting in the next 6 hours" rows={g.upNext} {...rowProps} />}
      <Group title="Always on" caption="Stations on the air around the clock" rows={g.always} {...rowProps} />
      {g.later.length > 0 && <Group title="Later" caption="Later, or at irregular times" rows={g.later} {...rowProps} />}
      <details className="signals-history">
        <summary>History ({g.history.length})</summary>
        <Group title={null} caption="Stations no longer on the air" rows={g.history} {...rowProps} />
      </details>
    </>
  );
}

function Group({
  title,
  caption,
  rows,
  ...row
}: { title: string | null; caption: string; rows: PanelRow[] } & RowProps) {
  return (
    <>
      {title && <p className="sched-head">{title}</p>}
      <table className="sched-strip" role="table">
        <caption className="visually-hidden">{caption}</caption>
        <tbody role="rowgroup">
          {rows.map((r) => (
            <Row key={r.station.slug} r={r} {...row} />
          ))}
        </tbody>
      </table>
    </>
  );
}

/** What a row's time cell says. */
/**
 * A row's channel. A Priyom RTTY slot's text is two pieces ("17532 kHz RTTY",
 * "· dial 17529.875 USB"), each kept whole, so a narrow phone cell breaks only
 * between them (owner, #148).
 */
function ChannelCell({ ch }: { ch: SignalChannel }) {
  const [first, second] = channelParts(ch);
  if (second === undefined) return <>{first}</>;
  return (
    <span className="sched-freq-parts">
      <span>{first}</span> <span>{second}</span>
    </span>
  );
}

function timeText(r: PanelRow, now: number, priyom: readonly PriyomTx[] | null): { text: string; checkPriyom: boolean } {
  const { schedule } = r.station;
  if (schedule.kind === "defunct")
    return { text: schedule.ended ? `Off the air since ${schedule.ended}` : "Off the air", checkPriyom: false };
  if (r.group === "always") return { text: "Always on", checkPriyom: false };
  if (r.group === "onNow") return { text: r.atMs === null ? "On now" : `${formatWait(r.atMs - now, false)} left`, checkPriyom: false };
  if (r.atMs !== null) return { text: `in ${formatWait(r.atMs - now, false)}`, checkPriyom: false };
  // A Priyom station with no slot listed this week, or no schedule from the server.
  if (r.station.priyom) return { text: priyom ? "Irregular" : "Schedule unavailable", checkPriyom: true };
  return { text: "Irregular", checkPriyom: false };
}

function Row({
  r,
  now,
  freqKhz,
  mode,
  priyom,
  heard,
  picked,
  busy,
  onListen,
}: { r: PanelRow } & RowProps) {
  const { station, listen, shown } = r;
  const ch = listen ?? shown;
  const tuned = ch !== null && ch.mode === mode && onKhz(freqKhz, ch.khz);
  // The picked station by frequency alone: after a mode change its row still counts as
  // picked, so a second press while it connects or plays can't restart Pick best.
  const isPicked = picked === station.slug && ch !== null && onKhz(freqKhz, ch.khz);
  const { text, checkPriyom } = timeText(r, now, priyom);
  const live = r.group !== "history";
  const heardLine = live ? heardText(heard?.[station.slug], now) : null;
  const aka = station.aka.length ? ` · ${station.aka.join(", ")}` : "";
  return (
    // Explicit roles: on phones the rows are laid out as a grid, as in the GhostNet strip.
    <tr role="row" data-current={tuned || undefined} data-picked={isPicked || undefined} data-slug={station.slug}>
      <th scope="row" role="rowheader" className={ch?.listedKhz !== undefined ? "sched-freq sched-freq-split" : "sched-freq"}>
        {ch ? <ChannelCell ch={ch} /> : "—"}
      </th>
      <td role="cell">
        <span className="signals-name">
          {/* The station's own page (#103), in a new tab: leaving the listening page would
              stop the audio, and a plain link (not next/link) means no in-app navigation.
              noreferrer: the listening page's URL can carry a receiver's address (?rx=). */}
          <a href={`/signals/${station.slug}`} target="_blank" rel="noopener noreferrer" className="signals-page-link">
            {station.name}
          </a>
          <span className="signals-aka">{aka}</span> <span className="signals-kind">{CATEGORY_LABELS[station.category]}</span>
        </span>
        <span className="sched-place">
          {station.tx?.label ?? station.blurb}
          {r.atMs !== null && (r.group === "upNext" || r.group === "later") && (
            <>
              {" · "}
              {utcLabel(r.atMs)} ({localLabel(r.atMs)})
            </>
          )}
        </span>
        {/* Its own line, there (empty) before any answer arrives (owner decision D5 on #102): a
            badge arriving or changing never changes the row's height, so it can't move another
            station's Listen under a press. */}
        {live && <span className="signals-heard">{heardLine}</span>}
      </td>
      <td role="cell">
        <span className="sched-next signals-wait">
          {text}
          {checkPriyom && (
            <>
              ,{" "}
              <a href={PRIYOM_SCHEDULE_PAGE} target="_blank" rel="noreferrer">
                check Priyom
              </a>
            </>
          )}
        </span>
        {listen && (
          <button
            type="button"
            className="link-button inline"
            aria-label={listenLabel(station, listen)}
            aria-pressed={isPicked}
            onClick={(e) => {
              // Pressing the picked row's Listen again while it connects or plays would restart
              // Pick best and could cut the audio, as on the GhostNet strip.
              if (e.detail <= 1 && !(isPicked && busy)) onListen(station, listen);
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
 * What the hidden status line says: only changes, never the countdowns, and
 * only about the station the listener picked (owner, after #124 shipped). The
 * section is always on the page and Priyom lists dozens of slots a day, so
 * speaking every station's start and end would interrupt a screen-reader user
 * all visit long, whatever they're listening to. For the picked station: it
 * connecting or playing, and its schedule slot starting or ending. The others'
 * state stays readable in the tables.
 */
function useAnnouncements(
  onNow: readonly PanelRow[] | null,
  picked: string | null,
  freqKhz: number,
  connecting: boolean,
  playing: boolean,
): string {
  const [text, setText] = useState("");
  const last = useRef<{ picked: string | null; slot: string | null; name: string | null; phase: string } | null>(
    null,
  );
  let phase = "";
  if (connecting) phase = "connecting";
  else if (playing) phase = "playing";
  const known = onNow !== null;
  // The picked station's slot on the air on the dial's frequency (On now), else null:
  // a slot on another frequency is silence here. Keyed by frequency too, so a slot
  // that moves elsewhere reads as an end. Always-on stations are never in On now.
  const row = picked
    ? onNow?.find((r) => r.station.slug === picked && r.listen !== null && onKhz(freqKhz, r.listen.khz))
    : undefined;
  const slot = row?.listen ? `${row.station.slug}@${row.listen.khz}` : null;
  const name = row?.station.name ?? null;

  useEffect(() => {
    if (!known) {
      last.current = null;
      return;
    }
    const prev = last.current;
    last.current = { picked, slot, name, phase };
    if (!prev) return;
    if (!picked) {
      // No pick: nothing to say, and a later identical line must read as new.
      if (prev.picked) setText("");
      return;
    }
    const same = prev.picked === picked;
    const lines: string[] = [];
    // Its slot starting or ending on the dial's frequency, for the same picked station only.
    if (same && slot && slot !== prev.slot) lines.push(`${name} on the air now.`);
    if (same && !slot && prev.slot) lines.push(`${prev.name} ended.`);
    // The run moving on: connecting, then playing. On a new pick only "Connecting…":
    // "playing" can still be the receiver that was playing before this Listen.
    if (same ? phase !== prev.phase : phase === "connecting") {
      if (phase === "connecting") lines.push("Connecting…");
      else if (phase === "playing") lines.push("Playing.");
    }
    if (lines.length) setText(lines.join(" "));
    // Back to idle (a failed connect, or Stop): clear the line, so pressing Listen again
    // and hearing the same "Connecting…" changes the live region and is spoken.
    else if (phase === "" && prev.phase !== "") setText("");
  }, [known, picked, slot, name, phase]);

  return text;
}
