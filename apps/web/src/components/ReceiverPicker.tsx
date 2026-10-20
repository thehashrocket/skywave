"use client";

import { useQuery } from "@tanstack/react-query";
import { memo, useDeferredValue, useMemo, useState } from "react";
import { byRank, covers, freeSlots, isFull, rankReceivers, receiverKey, type Receiver } from "@/lib/kiwi-list";
import { formatHostPort } from "@/lib/receiver";
import { useTRPC } from "@/lib/trpc";

const PAGE = 50;

type Props = {
  freqKhz: number;
  /** The receiver playing or connecting, marked in the table; null when nothing is. */
  current: { host: string; port: number } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (r: Receiver) => void;
  onPickBest: (ranked: Receiver[]) => void;
  /** A Pick best run is trying receivers; the button stops it instead. */
  picking: boolean;
  onStopPicking: () => void;
  note: string | null;
};

/** The public receiver list: a Pick best button plus a table to browse. */
export function ReceiverPicker({
  freqKhz,
  current,
  open,
  onOpenChange,
  onChoose,
  onPickBest,
  picking,
  onStopPicking,
  note,
}: Props) {
  const trpc = useTRPC();
  // The list changes slowly and the server caches it for 15 minutes, so
  // don't refetch on every focus.
  const list = useQuery({ ...trpc.receivers.list.queryOptions(), staleTime: 5 * 60_000 });
  const receivers = list.data?.receivers;
  const fetchedAt = list.data?.fetchedAt;

  return (
    <section className="receivers" aria-labelledby="receivers-heading">
      <h2 id="receivers-heading">Choose a receiver</h2>
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
          <summary>Browse {receivers.length.toLocaleString("en-US")} public receivers</summary>
          {/* Closed, it renders nothing, so S-meter ticks on the page cost nothing here. */}
          {open && (
            <ReceiverTable
              receivers={receivers}
              fetchedAt={fetchedAt}
              freqKhz={freqKhz}
              current={current}
              onChoose={onChoose}
            />
          )}
        </details>
      )}
    </section>
  );
}

type SortKey = "name" | "location" | "snr" | "free";

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "name", label: "Receiver" },
  { key: "location", label: "Location", className: "col-location" },
  { key: "snr", label: "SNR", className: "num" },
  { key: "free", label: "Listeners", className: "num" },
];

const COMPARE: Record<SortKey, (a: Receiver, b: Receiver) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  location: (a, b) => a.location.localeCompare(b.location),
  snr: (a, b) => (a.snr ?? -1) - (b.snr ?? -1),
  free: (a, b) => freeSlots(a) - freeSlots(b),
};

// Numbers read best biggest-first; text reads best A to Z.
const FIRST_DIRECTION: Record<SortKey, 1 | -1> = { name: 1, location: 1, snr: -1, free: -1 };

type TableProps = {
  receivers: readonly Receiver[];
  freqKhz: number;
  current: { host: string; port: number } | null;
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
  onChoose,
}: TableProps) {
  const [query, setQuery] = useState("");
  const [onlyFree, setOnlyFree] = useState(false);
  const [onlyCovering, setOnlyCovering] = useState(true);
  // null is the default: best first, the same order Pick best uses.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [showAll, setShowAll] = useState(false);

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
    const compare = COMPARE[sort.key];
    return matches.sort((a, b) => sort.dir * compare(a, b) || byRank(a, b));
  }, [receivers, searchText, listQuery, onlyFree, onlyCovering, listFreqKhz, sort]);

  const shown = showAll ? rows : rows.slice(0, PAGE);
  const currentKey = current && receiverKey(current);
  const freqText = freqKhz.toLocaleString("en-US", { maximumFractionDigits: 2 });

  const sortBy = (key: SortKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: FIRST_DIRECTION[key] }));

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
                  tuned={receiverKey(r) === currentKey}
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

type RowProps = { receiver: Receiver; tuned: boolean; onChoose: (r: Receiver) => void };

/**
 * One table row. Memoized so dial drags, which re-render the table header,
 * don't redo every row. The whole row is clickable; the name button is the
 * keyboard target, and its click bubbles to the row.
 */
const ReceiverRow = memo(function ReceiverRow({ receiver: r, tuned, onChoose }: RowProps) {
  return (
    <tr
      data-current={tuned || undefined}
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
        <button type="button" className="receiver-choose" aria-current={tuned || undefined}>
          <span className="receiver-name">
            {tuned && (
              <span className="receiver-tuned" aria-hidden="true">
                ●{" "}
              </span>
            )}
            {r.name}
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
      <td className="num">{r.snr ?? "–"}</td>
      <td className="num">
        {r.users}/{r.usersMax}
      </td>
    </tr>
  );
});
