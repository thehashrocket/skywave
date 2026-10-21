"use client";

import { useQuery } from "@tanstack/react-query";
import { memo, useDeferredValue, useMemo, useState, type ReactNode } from "react";
import {
  byRank,
  covers,
  freeSlots,
  isFull,
  LIST_MAX_AGE_MS,
  rankReceivers,
  receiverKey,
  type Receiver,
} from "@/lib/kiwi-list";
import { formatHostPort } from "@/lib/receiver";
import { isNight, type SunPosition } from "@/lib/solar";
import { useTRPC } from "@/lib/trpc";

const PAGE = 50;

/**
 * Time until the server's copy of the list (fetched at `fetchedAt`) expires,
 * plus a little slack, so the next poll gets a fresh one. Never sooner than a
 * minute, so a stale copy from a mirror outage isn't polled in a loop.
 */
export function nextRefetchMs(fetchedAt: number | undefined, now: number): number {
  if (fetchedAt === undefined) return LIST_MAX_AGE_MS;
  return Math.max(60_000, fetchedAt + LIST_MAX_AGE_MS - now + 5_000);
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
    refetchInterval: (query) => nextRefetchMs(query.state.data?.fetchedAt, Date.now()),
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
  receivers,
  fetchedAt,
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
  const [prevReceivers, setPrevReceivers] = useState(receivers);
  if (prevReceivers !== receivers) {
    setPrevReceivers(receivers);
    setSortSun(sun);
  }

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
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="name, place or antenna"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={onlyCovering} onChange={(e) => setOnlyCovering(e.target.checked)} />
          Covers {freqText} kHz
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} />
          Has a free slot
        </label>
        {sort ? (
          <button type="button" className="link-button" onClick={() => setSort(null)}>
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
          <table className="receivers-table">
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
