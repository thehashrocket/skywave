"use client";

import { useDeferredValue, useMemo, useState } from "react";
import type { Broadcast } from "@/lib/eibi";
import { langLabel, MIN_QUERY, searchStations } from "@/lib/station-search";

type Props = {
  /** The EiBi schedule; the section waits for it. */
  schedule?: readonly Broadcast[];
  /** The page's clock, ms; null until it's settled. */
  clock: number | null;
  freqKhz: number;
  onTune: (freqKhz: number) => void;
};

/** Stations shown before "Show all"; a common word can match a hundred. */
export const SHOWN = 12;

const khz = (f: number) => f.toLocaleString("en-US", { maximumFractionDigits: 2 });
const utc = (ms: number) => new Date(ms).toISOString().slice(11, 16).replace(":", "");

/**
 * Find a station by name in the EiBi schedule: what's on the air now comes
 * first, with a button per frequency that tunes there in AM; a station that's
 * off says when and where it's next on.
 */
export function StationSearch({ schedule, clock, freqKhz, onTune }: Props) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  // Typing stays quick while a search across the whole schedule catches up.
  const deferred = useDeferredValue(query);
  const results = useMemo(
    () => (schedule && clock !== null ? searchStations(schedule, deferred, clock) : []),
    [schedule, clock, deferred],
  );
  if (!schedule || clock === null) return null;

  const searching = query.trim().replace(/\s+/g, "").length >= MIN_QUERY;
  const onNow = results.filter((r) => r.now.length > 0).length;
  const shown = all ? results : results.slice(0, SHOWN);

  return (
    <section className="presets station-search" aria-labelledby="station-search-heading">
      <h2 id="station-search-heading">Find a station</h2>
      <form className="presets-save" role="search" onSubmit={(e) => e.preventDefault()}>
        <div className="presets-save-row">
          <label htmlFor="station-search-input" className="visually-hidden">
            Station name
          </label>
          <input
            id="station-search-input"
            type="search"
            placeholder="Station name, e.g. BBC or Radio Romania"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setAll(false);
            }}
          />
        </div>
      </form>
      <div role="status">
        {searching && (
          <p className="presets-note">
            {results.length === 0
              ? "No station by that name in this season's schedule."
              : `${results.length} ${results.length === 1 ? "station" : "stations"}, ${onNow} on the air now.`}
          </p>
        )}
      </div>

      {searching && shown.length > 0 && (
        <ul className="station-results">
          {shown.map((r) => (
            <li key={r.station} data-on={r.now.length > 0 || undefined}>
              <span className="station-result-name">{r.station}</span>
              {r.now.length > 0 ? (
                <span className="station-result-freqs">
                  {r.now.map((f) => (
                    <button
                      key={f.khz}
                      type="button"
                      className="station-freq"
                      data-current={Math.abs(f.khz - freqKhz) < 0.005 || undefined}
                      title={`Tune to ${khz(f.khz)} kHz · ${langLabel(f.lang)} · to ${f.target}`}
                      onClick={() => onTune(f.khz)}
                    >
                      <span className="preset-freq">{khz(f.khz)}</span>
                      <span className="station-freq-lang">{langLabel(f.lang)}</span>
                    </button>
                  ))}
                </span>
              ) : (
                <span className="station-result-off">
                  {r.next ? (
                    <>
                      Off now. Next on{" "}
                      <button type="button" className="link-button" onClick={() => onTune(r.next!.khz)}>
                        {khz(r.next.khz)} kHz
                      </button>{" "}
                      at {utc(r.next.at)} UTC
                      {r.next.lang && ` in ${langLabel(r.next.lang)}`}.
                    </>
                  ) : (
                    "Off now, and not on again in the next day."
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {searching && !all && results.length > SHOWN && (
        <button type="button" className="link-button" onClick={() => setAll(true)}>
          Show all {results.length}
        </button>
      )}
    </section>
  );
}
