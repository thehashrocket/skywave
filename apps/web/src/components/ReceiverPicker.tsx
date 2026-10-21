"use client";

import { useQuery } from "@tanstack/react-query";
import { memo, useDeferredValue, useMemo, useRef, useState, type ReactNode } from "react";
import {
  byRank,
  covers,
  freeSlots,
  isFull,
  LIST_MAX_AGE_MS,
  LIST_RETRY_MS,
  rankReceivers,
  receiverKey,
  type Receiver,
} from "@/lib/kiwi-list";
import { formatHostPort } from "@/lib/receiver";
import { isNight, type SunPosition } from "@/lib/solar";
import { useTRPC } from "@/lib/trpc";

const PAGE = 50;

// Slack after the server's copy expires, so the poll finds the new one.
const EXPIRY_SLACK_MS = 5_000;
// Just after expiry the server is fetching a new copy; ask again soon.
const JUST_EXPIRED_POLL_MS = 15_000;

/**
 * When to poll the list again, given how old the server's copy is now: just
 * after it expires. For one retry window after that, ask again soon; later,
 * the mirror is down, so follow the server's own retry pace. Never longer
 * than one cache lifetime.
 */
export function nextRefetchMs(age: number | undefined): number {
  // No list yet (the first load failed): try again soon, after the server's own short backoff.
  if (age === undefined) return JUST_EXPIRED_POLL_MS;
  if (age >= LIST_MAX_AGE_MS + LIST_RETRY_MS) return LIST_RETRY_MS;
  if (age >= LIST_MAX_AGE_MS) return JUST_EXPIRED_POLL_MS;
  return Math.min(LIST_MAX_AGE_MS, LIST_MAX_AGE_MS - age + EXPIRY_SLACK_MS);
}

export type Playing = { host: string; port: number; phase: "connecting" | "listening" };

type Props = {
  freqKhz: number;
  /** The receiver playing or connecting, marked in the table; null when nothing is. */
  current: Playing | null;
  /** Where the sun is now, from the page's clock; null before it starts. */
  sun: SunPosition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (r: Receiver) => void;
  onPickBest: (ranked: Receiver[]) => void;
  /** A Pick best run is trying receivers; the button stops it instead. */
  picking: boolean;
  onStopPicking: () => void;
  note: string | null;
  /** Shown under the heading, above the Pick best bar. */
  children?: ReactNode;
};

/** The public receiver list: a Pick best button plus a table to browse. */
export function ReceiverPicker({
  freqKhz,
  current,
  sun,
  open,
  onOpenChange,
  onChoose,
  onPickBest,
  picking,
  onStopPicking,
  note,
  children,
}: Props) {
  const trpc = useTRPC();
  // The list changes slowly and the server caches it for 15 minutes, so
  // don't refetch on every focus.
  const list = useQuery({
    ...trpc.receivers.list.queryOptions(),
    staleTime: 5 * 60_000,
    // Just after the server's copy expires, while the tab is visible, so
    // listener counts and full receivers stay current.
    // The server says how old its copy was when it answered; adding the time
    // since by this browser's clock keeps the two clocks from being compared.
    refetchInterval: (query) => {
      const data = query.state.data;
      return nextRefetchMs(data && (data.ageMs ?? 0) + (Date.now() - query.state.dataUpdatedAt));
    },
  });
  const receivers = list.data?.receivers;
  const fetchedAt = list.data?.fetchedAt;

  return (
    <section className="receivers" aria-labelledby="receivers-heading">
      <h2 id="receivers-heading">Receivers</h2>
      {children}
      <div className="receivers-bar">
        {/* Distinct keys, so the second click of a double-click lands on the
            other button (detail 2) and is ignored there instead of undoing the
            first click: cancelling the run, or starting a new one after Stop. */}
        {picking ? (
          <button
            key="stop"
            type="button"
            className="pick-best"
            onClick={(e) => {
              if (e.detail <= 1) onStopPicking();
            }}
          >
            Stop picking
          </button>
        ) : (
          <button
            key="pick"
            type="button"
            className="pick-best"
            disabled={!receivers}
            onClick={(e) => {
              if (e.detail <= 1 && receivers) onPickBest(rankReceivers(receivers, freqKhz));
            }}
          >
            Pick best receiver
          </button>
        )}
        <span className="receivers-note" role="status">
          {note ??
            (list.isPending ? (
              "Loading the public receiver list…"
            ) : !receivers ? (
              <>
                Couldn't load the public receiver list.{" "}
                <button type="button" className="link-button inline" onClick={() => void list.refetch()}>
                  Try again
                </button>{" "}
                or paste an address above.
              </>
            ) : list.data?.stale && fetchedAt ? (
              // A failed refetch keeps the old data; it's still usable, so say how old.
              `The public list isn't answering, so this is the copy from ${ago(Date.now() - fetchedAt)}.`
            ) : (
              "Highest signal-to-noise receiver that covers this frequency."
            ))}
        </span>
      </div>

      {receivers && (
        <details className="receivers-browse" open={open} onToggle={(e) => onOpenChange(e.currentTarget.open)}>
          <summary>All receivers ({receivers.length.toLocaleString("en-US")})</summary>
          {/* Closed, it renders nothing, so S-meter ticks on the page cost nothing here. */}
          {open && (
            <ReceiverTable
              receivers={receivers}
              fetchedAt={fetchedAt}
              freqKhz={freqKhz}
              current={current}
              sun={sun}
              onChoose={onChoose}
            />
          )}
        </details>
      )}
    </section>
  );
}

type SortKey = "name" | "location" | "night" | "snr" | "free";

// Listeners stays last: the full-row style mutes the last numeric cell.
const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "name", label: "Receiver" },
  { key: "location", label: "Location", className: "col-location" },
  { key: "night", label: "Night", className: "col-night" },
  { key: "snr", label: "SNR", className: "num" },
  { key: "free", label: "Listeners", className: "num" },
];

const COMPARE: Record<Exclude<SortKey, "night">, (a: Receiver, b: Receiver) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  location: (a, b) => a.location.localeCompare(b.location),
  snr: (a, b) => (a.snr ?? -1) - (b.snr ?? -1),
  free: (a, b) => freeSlots(a) - freeSlots(b),
};

// Numbers read best biggest-first; text reads best A to Z; night first.
const FIRST_DIRECTION: Record<SortKey, 1 | -1> = { name: 1, location: 1, night: -1, snr: -1, free: -1 };

/** Whether the sun has set at a receiver; null when we don't know where it is or when it is. */
function nightAt(r: Receiver, sun: SunPosition | null): boolean | null {
  return sun && r.lat !== undefined && r.lon !== undefined ? isNight(r.lat, r.lon, sun) : null;
}

type TableProps = {
  receivers: readonly Receiver[];
  freqKhz: number;
  current: Playing | null;
  sun: SunPosition | null;
  onChoose: (r: Receiver) => void;
  /** When the server fetched the list (ms since epoch). */
  fetchedAt?: number;
};

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

export const ReceiverTable = memo(function ReceiverTable({
  receivers: latest,
  fetchedAt: latestFetchedAt,
  freqKhz,
  current,
  sun,
  onChoose,
}: TableProps) {
  const [query, setQuery] = useState("");
  const [onlyFree, setOnlyFree] = useState(false);
  const [onlyCovering, setOnlyCovering] = useState(true);
  // null is the default: best first, the same order Pick best uses.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [showAll, setShowAll] = useState(false);
  // The Night sort uses the sun from when it was chosen (or the list last
  // changed), so rows don't reshuffle under the reader every minute. The
  // badges still follow the clock.
  const [sortSun, setSortSun] = useState(sun);
  // The list as shown. A refresh while the table is open waits behind "List
  // updated", so rows never move or drop out under a click; the listener's
  // next sort, filter or search takes the new list.
  const [view, setView] = useState({ receivers: latest, fetchedAt: latestFetchedAt });
  const { receivers, fetchedAt } = view;
  const updated = receivers !== latest;
  const adopt = () => {
    if (!updated) return;
    setView({ receivers: latest, fetchedAt: latestFetchedAt });
    setSortSun(sun);
  };
  // Every control that reshapes the rows takes the new list first.
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      adopt();
      set(v);
    };
  const tableRef = useRef<HTMLTableElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const showUpdated = () => {
    adopt();
    // The button goes away; keep keyboard focus in the list, on the first receiver.
    setTimeout(() => (tableRef.current?.querySelector<HTMLElement>(".receiver-choose") ?? searchRef.current)?.focus());
  };

  const searchText = useMemo(
    () => new Map(receivers.map((r) => [r, `${r.name} ${r.location} ${r.antenna} ${r.host}`.toLowerCase()])),
    [receivers],
  );
  // Dragging the dial or typing shouldn't wait on re-sorting ~900 rows.
  const listQuery = useDeferredValue(query);
  const listFreqKhz = useDeferredValue(freqKhz);

  const rows = useMemo(() => {
    const words = listQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = receivers.filter((r) => {
      if (onlyFree && isFull(r)) return false;
      if (onlyCovering && !covers(r, listFreqKhz)) return false;
      const haystack = searchText.get(r)!;
      return words.every((w) => haystack.includes(w));
    });
    if (!sort) return matches.sort(byRank);
    if (sort.key === "night") {
      const night = new Map(matches.map((r) => [r, nightAt(r, sortSun)]));
      // Receivers with no position go last whichever way the column sorts.
      return matches.sort((a, b) => {
        const x = night.get(a)!;
        const y = night.get(b)!;
        if (x === null || y === null) return Number(x === null) - Number(y === null) || byRank(a, b);
        return sort.dir * (Number(x) - Number(y)) || byRank(a, b);
      });
    }
    const compare = COMPARE[sort.key];
    return matches.sort((a, b) => sort.dir * compare(a, b) || byRank(a, b));
  }, [receivers, searchText, listQuery, onlyFree, onlyCovering, listFreqKhz, sort, sortSun]);

  const shown = showAll ? rows : rows.slice(0, PAGE);
  const currentKey = current && receiverKey(current);
  const freqText = freqKhz.toLocaleString("en-US", { maximumFractionDigits: 2 });

  const sortBy = (key: SortKey) => {
    adopt();
    if (key === "night") setSortSun(sun);
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: FIRST_DIRECTION[key] }));
  };

  return (
    <div className="receivers-table-wrap">
      <div className="receivers-filters">
        <div className="field receivers-search">
          <label htmlFor="receiver-search">Search</label>
          <input
            id="receiver-search"
            type="search"
            ref={searchRef}
            value={query}
            onChange={(e) => edit(setQuery)(e.target.value)}
            placeholder="name, place or antenna"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={onlyCovering} onChange={(e) => edit(setOnlyCovering)(e.target.checked)} />
          Covers {freqText} kHz
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyFree} onChange={(e) => edit(setOnlyFree)(e.target.checked)} />
          Has a free slot
        </label>
        {sort ? (
          <button type="button" className="link-button" onClick={() => edit(setSort)(null)}>
            Sort by best
          </button>
        ) : (
          <span className="receivers-sort-note">Best first</span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="receivers-empty">
          <p>No receivers match.</p>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              adopt();
              setQuery("");
              setOnlyFree(false);
              setOnlyCovering(false);
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="receivers-scroll">
          <table className="receivers-table" ref={tableRef}>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    className={c.className}
                    aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                  >
                    <button type="button" onClick={() => sortBy(c.key)}>
                      {c.label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <ReceiverRow
                  key={receiverKey(r)}
                  receiver={r}
                  tuned={receiverKey(r) === currentKey ? current!.phase : undefined}
                  night={nightAt(r, sun)}
                  onChoose={onChoose}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > shown.length && (
        <button type="button" className="link-button" onClick={() => setShowAll(true)}>
          Show all {rows.length.toLocaleString("en-US")}
        </button>
      )}
      {/* Below the table, so it never moves the rows; always present, so screen readers announce it. */}
      <span className="receivers-updated" role="status">
        {updated && (
          <>
            List updated.{" "}
            <button type="button" className="link-button" onClick={showUpdated}>
              Show it
            </button>
          </>
        )}
      </span>
      <p className="receivers-credit">
        List {fetchedAt ? `fetched ${ago(Date.now() - fetchedAt)}` : "fetched"} from{" "}
        <a href="http://rx.linkfanel.net/" target="_blank" rel="noreferrer">
          rx.linkfanel.net
        </a>
        , which mirrors kiwisdr.com/public. Listener counts can be up to 20 minutes older than that.
      </p>
    </div>
  );
});

type RowProps = {
  receiver: Receiver;
  /** Set on the receiver that's playing or connecting. */
  tuned: Playing["phase"] | undefined;
  night: boolean | null;
  onChoose: (r: Receiver) => void;
};

/**
 * One table row. Memoized so dial drags, which re-render the table header,
 * don't redo every row. The whole row is clickable; the name button is the
 * keyboard target, and its click bubbles to the row.
 */
const ReceiverRow = memo(function ReceiverRow({ receiver: r, tuned, night, onChoose }: RowProps) {
  return (
    <tr
      data-current={tuned}
      data-full={isFull(r) || undefined}
      onClick={(e) => {
        // Dragging across this row to select text (say, to copy an address)
        // isn't a choice. Keyboard activation (detail 0) always is.
        const sel = window.getSelection();
        const selecting = e.detail > 0 && sel && !sel.isCollapsed && sel.containsNode(e.currentTarget, true);
        if (!selecting) onChoose(r);
      }}
    >
      <td>
        <button type="button" className="receiver-choose" aria-current={tuned ? "true" : undefined}>
          <span className="receiver-name">
            {/* A ring while connecting, a filled dot once it plays: the map's marks. */}
            {tuned && (
              <span className="receiver-tuned" aria-hidden="true">
                {tuned === "connecting" ? "○" : "●"}{" "}
              </span>
            )}
            {r.name}
            {tuned === "connecting" && <span className="visually-hidden"> (connecting)</span>}
          </span>
          <span className="receiver-host">
            {formatHostPort(r.host, r.port)}
            {r.antenna && ` · ${r.antenna}`}
          </span>
        </button>
      </td>
      <td className="col-location">
        {/* Browsers ignore max-width on a table cell; this one holds it. */}
        <span className="location-text">{r.location}</span>
      </td>
      <td className="col-night" data-night={night ?? undefined}>
        {night === null ? "–" : night ? "Night" : "Day"}
      </td>
      <td className="num">{r.snr ?? "–"}</td>
      <td className="num">
        {r.users}/{r.usersMax}
      </td>
    </tr>
  );
});
