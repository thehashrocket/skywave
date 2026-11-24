"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type Broadcast, languageChoices, languageNames, type LanguageChoice, MATCH_KHZ, pickedNames } from "@/lib/eibi";
import { areaCodes, BROAD_REGIONS, broadRegionAt, isBroadRegion, regionName } from "@/lib/eibi-targets";
import type { Mode } from "@/lib/radio-types";
import {
  type AreaFilter,
  clickMode,
  type Filters,
  filtering,
  findBroadcasts,
  type FoundBroadcast,
  inBroadcastBand,
  NO_FILTERS,
  type SearchResult,
  startsParts,
  startsSentence,
} from "@/lib/station-search";
import type { ScanSignal } from "@/lib/use-radio";
import { LanguagePicker } from "./LanguagePicker";
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
  /**
   * Pick best for the clicked row's frequency and mode: pick source "search"
   * for a row found by name, "browse" for one from the on-now list (eng D9).
   */
  onPickBest: (freqKhz: number, mode: Mode, source: "search" | "browse") => void;
  /** Where the receiver playing is, when the list gives its position: the area filter suggests its region (eng D2). */
  receiverPlace?: { lat: number; lon: number };
};

/** Rows per page (D5). */
export const PAGE_ROWS = 20;
/** How long typing must pause before the count is read out (design 13A). */
export const ANNOUNCE_DELAY_MS = 500;

const khz = (f: number) => f.toLocaleString("en-US", { maximumFractionDigits: 2 });
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const language = (codes: string) => languageNames(codes) || codes;
const title = (f: FoundBroadcast) => (f.lang ? `${f.station} · ${language(f.lang)}` : f.station);

/** Where filters are kept between visits (#109, #110). */
export const FILTERS_KEY = "skywave.stationFilters";

/**
 * The saved filters, or none if what's stored isn't the shape this page
 * writes. The area is kept as the select's value ("region:na"); one this page
 * can't read is Any, keeping the rest.
 */
function loadFilters(): Filters | null {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object") return null;
    const { area, languages, nonVoice } = v as Record<string, unknown>;
    if (typeof area !== "string" || !Array.isArray(languages) || !languages.every((c) => typeof c === "string"))
      return null;
    if (typeof nonVoice !== "boolean") return null;
    return { area: areaOf(area), language: { codes: languages, nonVoice } };
  } catch {
    return null; // storage unavailable or unreadable
  }
}

function saveFilters(f: Filters) {
  try {
    const saved = { area: areaValue(f.area), languages: f.language.codes, nonVoice: f.language.nonVoice };
    localStorage.setItem(FILTERS_KEY, JSON.stringify(saved));
  } catch {
    /* ignore */
  }
}

/** "English", "English or Spanish", "English, French or Spanish", "5 languages". */
function orList(names: string[]): string {
  if (names.length > 3) return `${names.length} languages`;
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : (names[0] ?? "");
}

/** The active filters in words, for the status line (eng D6): "in English to Africa", "" for none. */
function describeFilters(f: Filters, choices: readonly LanguageChoice[], areaName: string | undefined): string {
  const langs = pickedNames(choices, f.language.codes);
  return [
    langs.length ? `in ${orList(langs)}` : "",
    areaName ? `to ${areaName}` : "",
    f.language.nonVoice ? "" : "with non-voice hidden",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The status line: what's happening, the totals, or why nothing matched
 * (design 2A, 3A, 4A, 5A; filters #109/#110 design 2A, eng D6).
 */
function statusText(
  ready: boolean,
  loadFailed: boolean,
  query: string,
  result: SearchResult | null,
  described: string,
): string {
  if (!ready) return loadFailed ? "Couldn't load the station schedule." : "Loading the schedule…";
  if (!result) return "";
  const { found, names, unfiltered } = result;
  const what = described ? ` ${described}` : "";
  if (query.trim() === "") {
    if (found.length > 0)
      return `${plural(found.length, "broadcast", "broadcasts")} on now${what}, broadcast bands first. Type a name to find one station.`;
    return described ? `Nothing${what} is on now.` : "Nothing in the schedule is on now.";
  }
  if (found.length > 0) {
    const onNow = found.filter((f) => f.onNow).length;
    const count = (n: number) => n.toLocaleString("en-US");
    return `${plural(found.length, "broadcast", "broadcasts")}${what}: ${count(onNow)} on now, ${count(found.length - onNow)} later in the next 24 hours.`;
  }
  if (unfiltered > 0) {
    const has = plural(unfiltered, "broadcast", "broadcasts");
    return names.length === 1
      ? `${names[0]} has ${has} in the next 24 hours, none${what}.`
      : `The ${names.length} matching stations have ${has} in the next 24 hours, none${what}.`;
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

/**
 * A note under the count, after a click (design 6B, 7A): "idle" and "range"
 * show while still true; "later" is worded from the clock each minute.
 */
type Note = { kind: "idle" | "range"; khz: number; mode: Mode; browse: boolean } | { kind: "later"; row: FoundBroadcast };

const NO_NAMES: Readonly<Record<string, string>> = {};

/** The area select's value for a filter: "", "region:na", "code:WEu". */
const areaValue = (a: AreaFilter) => (a === null ? "" : "region" in a ? `region:${a.region}` : `code:${a.code}`);
function areaOf(value: string): AreaFilter {
  const region = value.startsWith("region:") ? value.slice(7) : "";
  if (isBroadRegion(region)) return { region };
  if (value.startsWith("code:") && value.length > 5) return { code: value.slice(5) };
  return null;
}

/**
 * Find a station by name (a listener's request): every broadcast of a
 * matching station on the air now or starting in the next 24 hours, one row
 * per frequency, time and language; a row tunes the dial there. With no name
 * typed, everything on the air now (#109/#110 eng D1), the shortwave
 * broadcast bands first (design 5A). Both lists narrow by where broadcasts
 * are aimed and their language, remembered between visits.
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
  receiverPlace,
}: Props) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE_ROWS);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  // The text to read out, and a count that flips a trailing no-break space so the
  // same words are read again when they're announced again (retyping a query).
  const [announced, setAnnounced] = useState({ text: "", n: 0 });
  const announce = (text: string) => setAnnounced((a) => ({ text, n: a.n + 1 }));
  const listRef = useRef<HTMLDivElement>(null);
  const focusRow = useRef<number | null>(null);
  const announceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);

  const ready = schedule !== undefined && clock !== null;
  const typed = query.trim() !== "";
  const result = useMemo(
    () => (ready ? findBroadcasts(schedule.broadcasts, query, clock, schedule.season, filters) : null),
    [ready, schedule, query, clock, filters],
  );
  const found = result?.found ?? [];
  const visible = found.slice(0, shown);
  const remaining = found.length - visible.length;

  const broadcasts = schedule?.broadcasts;
  const choices = useMemo(() => languageChoices(broadcasts ?? [], filters.language.codes), [broadcasts, filters.language.codes]);
  const { area } = filters;
  const savedCode = area && "code" in area ? area.code : undefined;
  // An older server sends no targetNames; its codes show as themselves.
  const targetNames = schedule?.targetNames ?? NO_NAMES;
  const codes = useMemo(() => areaCodes(broadcasts ?? [], targetNames, savedCode), [broadcasts, targetNames, savedCode]);
  const areaName = !area ? undefined : "region" in area ? regionName(area.region) : codes.find((c) => c.code === area.code)?.name;
  const described = describeFilters(filters, choices, areaName);
  const status = statusText(ready, loadFailed, query, result, described);
  const suggested = receiverPlace && area === null ? broadRegionAt(receiverPlace.lat, receiverPlace.lon) : undefined;

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
  // Saved filters load after the first render, so the server's HTML and the
  // page's first render agree (as page.tsx loads the receiver). The count is
  // read out again for them: a schedule already held was just announced
  // unfiltered, and this runs after that effect so its announcement can't
  // cancel this one.
  useEffect(() => {
    const saved = loadFilters();
    if (!saved) return;
    setFilters(saved);
    // Before the schedule is in, the loading effect reads the filtered count out once it lands.
    if (ready) restart();
  }, []);

  // After "Show more", focus moves to the first row it revealed.
  useEffect(() => {
    if (focusRow.current === null) return;
    listRef.current?.querySelectorAll<HTMLButtonElement>(".preset-tune")[focusRow.current]?.focus();
    focusRow.current = null;
  }, [shown, phoneOpen]);

  // A new list starts at its first page, with the count read out once changes pause (design 13A).
  const restart = () => {
    setShown(PAGE_ROWS);
    setPhoneOpen(false);
    setNote(null);
    clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => announce(statusRef.current), ANNOUNCE_DELAY_MS);
  };

  const edit = (text: string) => {
    setQuery(text);
    restart();
  };
  const refilter = (next: Filters) => {
    setFilters(next);
    saveFilters(next);
    restart();
  };

  const tune = (f: FoundBroadcast) => {
    const mode = clickMode(f.khz, f.lang, f.station);
    onTune(f.khz, mode);
    const browse = !typed;
    if (idle) setNote({ kind: "idle", khz: f.khz, mode, browse });
    else if (reaches && !reaches(f.khz)) setNote({ kind: "range", khz: f.khz, mode, browse });
    else if (!f.onNow && f.startsAt !== undefined) setNote({ kind: "later", row: f });
    else setNote(null);
  };

  const noteText =
    note?.kind === "idle" && idle
      ? "Nothing is playing."
      : note?.kind === "range" && !idle && reaches && !reaches(note.khz)
        ? `This receiver doesn't reach ${khz(note.khz)} kHz.`
        : note?.kind === "later" && note.row.startsAt !== undefined && clock !== null
          ? note.row.startsAt > clock
            ? `${title(note.row)} ${startsSentence(note.row.startsAt, clock)}.`
            : `${title(note.row)} should be on now.`
          : "";
  const offerPick = note !== null && note.kind !== "later" && noteText !== "";

  const isStrong = (f: FoundBroadcast) =>
    f.onNow && (strong?.some((s) => Math.abs(s.freqKhz - f.khz) <= MATCH_KHZ) ?? false);

  const row = (f: FoundBroadcast, i: number): ReactNode => {
    const mode = clickMode(f.khz, f.lang, f.station);
    const targets = f.targets
      .map((t) => (Object.hasOwn(targetNames, t) ? targetNames[t] : undefined))
      .filter((n): n is string => !!n);
    const to = [...new Set(targets)].join(", ");
    const strongHere = isStrong(f);
    const when = f.onNow ? null : startsParts(f.startsAt!, clock!);
    const current = Math.abs(f.khz - freqKhz) < 0.005;
    const spoken = spokenLabel(f, mode, when, to, strongHere);
    const rowId = [f.khz, f.station, f.lang, f.startsAt ?? "now"].join("|");
    return (
      <li key={rowId} data-current={current || undefined} data-beyond={i >= PHONE_ROWS || undefined}>
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
                  <span className="station-strong" title="This receiver's scan heard a strong signal on this frequency.">
                    Strong here
                  </span>
                )}
              </span>
            )}
          </span>
        </button>
      </li>
    );
  };
  // With no name typed, the rows outside the broadcast bands follow under their own heading (design 9A).
  const split = typed ? -1 : visible.findIndex((f) => !inBroadcastBand(f.khz));
  const inBands = split < 0 ? visible : visible.slice(0, split);
  const outside = split < 0 ? [] : visible.slice(split);

  return (
    <section
      className="presets station-search"
      aria-labelledby="station-search-heading"
      data-phone-open={phoneOpen || undefined}
    >
      <h2 id="station-search-heading">Find a station</h2>
      <div className="station-filters">
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
        <div className="field">
          <label htmlFor="station-area-select">Aimed at</label>
          <select
            id="station-area-select"
            value={areaValue(filters.area)}
            disabled={!ready}
            onChange={(e) => refilter({ ...filters, area: areaOf(e.target.value) })}
          >
            <option value="">Any area</option>
            <optgroup label="Regions">
              {BROAD_REGIONS.map((r) => (
                <option key={r.id} value={`region:${r.id}`}>
                  {r.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Areas and countries">
              {codes.map((c) => (
                <option key={c.code} value={`code:${c.code}`}>
                  {c.stale ? `${c.name} (none in this schedule)` : c.name}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <LanguagePicker
          choices={choices}
          picked={filters.language.codes}
          disabled={!ready}
          onChange={(codes) => refilter({ ...filters, language: { ...filters.language, codes } })}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={filters.language.nonVoice}
            disabled={!ready}
            onChange={(e) => refilter({ ...filters, language: { ...filters.language, nonVoice: e.target.checked } })}
          />
          Include non-voice (time signals, Morse, data)
        </label>
      </div>
      {/* Held, so the suggestion arriving with a receiver doesn't push the list down (design 7A). */}
      <p className="station-search-note station-suggest">
        {ready && suggested && (
          <>
            <button
              type="button"
              className="link-button inline"
              onClick={() => refilter({ ...filters, area: { region: suggested } })}
            >
              Aimed at {regionName(suggested)}
            </button>{" "}
            (where this receiver is)?
          </>
        )}
      </p>
      <p className="presets-note station-search-status">{status}</p>
      {!ready && loadFailed && (
        <button type="button" className="link-button station-search-retry" onClick={onRetry}>
          Try again
        </button>
      )}
      {ready && found.length === 0 && filtering(filters) && (
        <button
          type="button"
          className="link-button station-search-clear"
          onClick={() => {
            refilter(NO_FILTERS);
            document.getElementById("station-search-input")?.focus();
          }}
        >
          Clear filters
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
          <button
            type="button"
            className="link-button inline"
            onClick={() => onPickBest(note.khz, note.mode, note.browse ? "browse" : "search")}
          >
            Pick best for {khz(note.khz)} kHz
          </button>
        )}
      </div>

      <div ref={listRef}>
        {inBands.length > 0 && <ul className="presets-list station-results">{inBands.map((f, i) => row(f, i))}</ul>}
        {outside.length > 0 && (
          <>
            <h3 className="station-outside" data-beyond={split >= PHONE_ROWS || undefined}>
              Outside the broadcast bands
            </h3>
            <ul className="presets-list station-results">{outside.map((f, i) => row(f, split + i))}</ul>
          </>
        )}
      </div>
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
