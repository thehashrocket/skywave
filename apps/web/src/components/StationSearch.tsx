"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type Broadcast, languageNames, MATCH_KHZ } from "@/lib/eibi";
import type { Mode } from "@/lib/radio-types";
import {
  clickMode,
  findBroadcasts,
  type FoundBroadcast,
  type SearchResult,
  startsParts,
  startsSentence,
} from "@/lib/station-search";
import type { ScanSignal } from "@/lib/use-radio";
import { PHONE_ROWS } from "./SignalList";

/** The schedule as the page gets it (stations.schedule). */
export type SearchSchedule = { broadcasts: readonly Broadcast[]; season: string; targetNames: Record<string, string> };

type Props = {
  /** Undefined until it loads. */
  schedule?: SearchSchedule;
  /** The schedule couldn't be loaded (and none is held). */
  loadFailed: boolean;
  onRetry: () => void;
  /** The page's clock, the one the station names use (D6); null until it's set. */
  clock: number | null;
  freqKhz: number;
  /** This receiver's finished band scan, for "Strong here"; null when there's none for the receiver playing. */
  strong: readonly ScanSignal[] | null;
  /** No receiver playing or connecting. */
  idle: boolean;
  /** Whether the receiver playing reaches a frequency; undefined when that's unknown. */
  reaches?: (freqKhz: number) => boolean;
  onTune: (freqKhz: number, mode: Mode) => void;
  /** Pick best for the dial's frequency (pick source "search"). */
  onPickBest: () => void;
};

/** Rows per page (D5). */
export const PAGE_ROWS = 20;
/** How long typing must pause before the count is read out (design 13A). */
export const ANNOUNCE_DELAY_MS = 500;

const khz = (f: number) => f.toLocaleString("en-US", { maximumFractionDigits: 2 });
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const language = (codes: string) => languageNames(codes) || codes;
const title = (f: FoundBroadcast) => (f.lang ? `${f.station} · ${language(f.lang)}` : f.station);

/** The status line: what's happening, the totals, or why nothing matched (design 2A, 3A, 4A, 5A). */
function statusText(ready: boolean, loadFailed: boolean, query: string, result: SearchResult | null): string {
  if (!ready) return loadFailed ? "Couldn't load the station schedule." : "Loading the schedule…";
  if (!result) return "Type part of a station's name, like BBC or Nacional.";
  const { found, names } = result;
  if (found.length > 0) {
    const onNow = found.filter((f) => f.onNow).length;
    const count = (n: number) => n.toLocaleString("en-US");
    return `${plural(found.length, "broadcast", "broadcasts")}: ${count(onNow)} on now, ${count(found.length - onNow)} later in the next 24 hours.`;
  }
  if (names.length === 0) return `No station named “${query.trim()}” in this season's schedule. Try part of the name.`;
  if (names.length === 1) return `${names[0]} isn't scheduled in the next 24 hours.`;
  return `None of the ${names.length} matching stations are scheduled in the next 24 hours.`;
}

/** What a row's button says to a screen reader (design 14A, 15B): "12,095 kHz, BBC, English, on now, to South Asia, strong here". */
function spokenLabel(
  f: FoundBroadcast,
  mode: Mode,
  when: { time: string; until: string } | null,
  to: string,
  strongHere: boolean,
) {
  return [
    `${khz(f.khz)} kHz${mode === "am" ? "" : ` ${mode.toUpperCase()}`}`,
    f.station,
    f.lang && language(f.lang),
    when ? `starts ${when.time}, ${when.until}` : "on now",
    to && `to ${to}`,
    strongHere && "strong here",
  ]
    .filter(Boolean)
    .join(", ");
}

/** A note under the count, after a click (design 6B, 7A); "idle" and "range" show while still true. */
type Note = { kind: "idle" | "range"; khz: number } | { kind: "later"; text: string };

/**
 * Find a station by name (a listener's request): every broadcast of a
 * matching station on the air now or starting in the next 24 hours, one row
 * per frequency, time and language; a row tunes the dial there.
 */
export function StationSearch({
  schedule,
  loadFailed,
  onRetry,
  clock,
  freqKhz,
  strong,
  idle,
  reaches,
  onTune,
  onPickBest,
}: Props) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE_ROWS);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  // The text to read out, and a count that flips a trailing no-break space so the
  // same words are read again when they're announced again (retyping a query).
  const [announced, setAnnounced] = useState({ text: "", n: 0 });
  const announce = (text: string) => setAnnounced((a) => ({ text, n: a.n + 1 }));
  const listRef = useRef<HTMLUListElement>(null);
  const focusRow = useRef<number | null>(null);
  const announceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const ready = schedule !== undefined && clock !== null;
  const typed = query.trim() !== "";
  const result = useMemo(
    () => (ready && typed ? findBroadcasts(schedule.broadcasts, query, clock, schedule.season) : null),
    [ready, typed, schedule, query, clock],
  );
  const found = result?.found ?? [];
  const visible = found.slice(0, shown);
  const remaining = found.length - visible.length;

  const status = statusText(ready, loadFailed, query, result);

  // The count is read out once typing pauses; loading, a failure and paging
  // at once, and any of those cancels a count still waiting (design 13A). A
  // minute going by changes the count silently.
  const statusRef = useRef(status);
  statusRef.current = status;
  const announceNow = (text: string) => {
    clearTimeout(announceTimer.current);
    announce(text);
  };
  const phase = ready ? "ready" : loadFailed ? "failed" : "loading";
  useEffect(() => {
    if (phase !== "loading") announceNow(statusRef.current);
  }, [phase]);
  useEffect(() => () => clearTimeout(announceTimer.current), []);

  // After "Show more", focus moves to the first row it revealed.
  useEffect(() => {
    if (focusRow.current === null) return;
    listRef.current?.querySelectorAll<HTMLButtonElement>(".preset-tune")[focusRow.current]?.focus();
    focusRow.current = null;
  }, [shown, phoneOpen]);

  const edit = (text: string) => {
    setQuery(text);
    setShown(PAGE_ROWS);
    setPhoneOpen(false);
    setNote(null);
    clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => announce(statusRef.current), ANNOUNCE_DELAY_MS);
  };

  const tune = (f: FoundBroadcast) => {
    onTune(f.khz, clickMode(f.khz));
    if (idle) setNote({ kind: "idle", khz: f.khz });
    else if (reaches && !reaches(f.khz)) setNote({ kind: "range", khz: f.khz });
    else if (!f.onNow && f.startsAt !== undefined && clock !== null)
      setNote({ kind: "later", text: `${title(f)} ${startsSentence(f.startsAt, clock)}.` });
    else setNote(null);
  };

  const noteText =
    note?.kind === "idle" && idle
      ? "Nothing is playing."
      : note?.kind === "range" && !idle && reaches && !reaches(note.khz)
        ? `This receiver doesn't reach ${khz(note.khz)} kHz.`
        : note?.kind === "later"
          ? note.text
          : "";
  const offerPick = note !== null && note.kind !== "later" && noteText !== "";

  const isStrong = (f: FoundBroadcast) =>
    f.onNow && (strong?.some((s) => Math.abs(s.freqKhz - f.khz) <= MATCH_KHZ) ?? false);

  return (
    <section
      className="presets station-search"
      aria-labelledby="station-search-heading"
      data-phone-open={phoneOpen || undefined}
    >
      <h2 id="station-search-heading">Find a station</h2>
      <div className="field station-search-field">
        <label htmlFor="station-search-input">Station name</label>
        <input
          id="station-search-input"
          type="search"
          value={query}
          disabled={!ready}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => {
            // Browsers that don't clear a search field on Escape.
            if (e.key === "Escape" && query) edit("");
          }}
        />
      </div>
      <p className="presets-note station-search-status">{status}</p>
      {!ready && loadFailed && (
        <button type="button" className="link-button station-search-retry" onClick={onRetry}>
          Try again
        </button>
      )}
      {/* Read out after a pause in typing; the line above updates at once but isn't live. */}
      <div role="status" className="visually-hidden">
        {announced.text}
        {announced.n % 2 ? "\u00a0" : ""}
      </div>
      <div className="station-search-note">
        <span role="status">{noteText}</span>
        {offerPick && (
          <button type="button" className="link-button inline" onClick={onPickBest}>
            Pick best for {khz(freqKhz)} kHz
          </button>
        )}
      </div>

      {visible.length > 0 && (
        <ul ref={listRef} className="presets-list station-results">
          {visible.map((f, i) => {
            const mode = clickMode(f.khz);
            // An older server sends no targetNames; its rows just have no "to" line.
            const targets = f.targets.map((t) => schedule!.targetNames?.[t]).filter((n): n is string => !!n);
            const to = [...new Set(targets)].join(", ");
            const strongHere = isStrong(f);
            const when = f.onNow ? null : startsParts(f.startsAt!, clock!);
            const current = Math.abs(f.khz - freqKhz) < 0.005;
            const spoken = spokenLabel(f, mode, when, to, strongHere);
            const rowId = [f.khz, f.station, f.lang, f.startsAt ?? "now"].join("|");
            return (
              <li
                key={rowId}
                data-current={current || undefined}
                data-beyond={i >= PHONE_ROWS || undefined}
              >
                <button
                  type="button"
                  className="preset-tune"
                  aria-current={current || undefined}
                  aria-label={spoken}
                  onClick={() => tune(f)}
                >
                  <span className="preset-freq">{khz(f.khz)}</span>
                  <span className="station-when">
                    <span>
                      {when ? when.time : "on now"}
                      {mode !== "am" && <span className="preset-mode"> {mode.toUpperCase()}</span>}
                    </span>
                    {when && <span className="station-when-until">{when.until}</span>}
                  </span>
                  <span className="signal-what">
                    <span className="signal-station">
                      <span className="signal-station-name">{title(f)}</span>
                    </span>
                    {(to || strongHere) && (
                      <span className="station-second">
                        {to && <span className="station-to">to {to}</span>}
                        {strongHere && (
                          <span
                            className="station-strong"
                            title="This receiver's scan heard a strong signal on this frequency."
                          >
                            Strong here
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {visible.length > PHONE_ROWS && !phoneOpen && (
        // Phones only (the 520px block): the rest of this page of rows.
        <button
          type="button"
          className="link-button station-phone-more"
          onClick={() => {
            focusRow.current = PHONE_ROWS;
            setPhoneOpen(true);
          }}
        >
          Show {visible.length - PHONE_ROWS} more
        </button>
      )}
      {remaining > 0 && (
        <button
          type="button"
          className="link-button station-more"
          onClick={() => {
            focusRow.current = visible.length;
            setShown(shown + PAGE_ROWS);
            setPhoneOpen(true);
            announceNow(`Showing ${Math.min(shown + PAGE_ROWS, found.length)} of ${found.length}.`);
          }}
        >
          {remaining > PAGE_ROWS ? `Show ${PAGE_ROWS} more of ${remaining}` : `Show the last ${remaining}`}
        </button>
      )}
    </section>
  );
}
