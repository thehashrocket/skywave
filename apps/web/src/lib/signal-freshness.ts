/**
 * The weekly signal-stations freshness report (#147): what in the hand-kept
 * catalog (signal-stations.ts) needs a person to look at it. A GitHub Action
 * reads it from /api/signals/freshness every Monday and keeps one open issue
 * with the body this file writes. Nothing here edits the catalog or hides a
 * station: a person checks the sources, edits the entry, and bumps `checked`.
 * Pure: the route passes the answers, Priyom's state and the time.
 */

import { PRIYOM_SCHEDULE_PAGE, PRIYOM_UNCHANGED_MS, priyomUnchanged, type PriyomFeedRecord, type PriyomTx } from "./priyom-schedule";
import { ACTIVITY_WINDOW_MS, stationActivity, SUSPECT_MIN_LISTENERS, SUSPECT_MIN_NOT_HEARD, type AnswerTally } from "./signal-heard";
import { SIGNAL_STATIONS, type SignalStation } from "./signal-stations";

const DAY = 24 * 60 * 60_000;

/** An entry not checked against its sources in this long is listed. */
export const CHECKED_STALE_MS = 180 * DAY;
/** This server's Priyom copy older than this means its refreshes aren't landing (they run every 6 hours). */
export const PRIYOM_COPY_STALE_MS = DAY;
/** The shared Priyom record not saved by any server in this long means saves are failing or nothing is fetching. */
export const PRIYOM_RECORD_STALE_MS = 2 * DAY;

/** A catalog entry, as the report names it. */
type Entry = { slug: string; name: string; sources: readonly string[] };

export type FreshnessReport = {
  /** ISO time the report was made. */
  at: string;
  /** Entries whose `checked` is older than CHECKED_STALE_MS. */
  stale: (Entry & { checked: string; days: number })[];
  /** Always-on stations nobody has heard in ACTIVITY_WINDOW_MS while several listeners said they didn't (stationActivity). */
  suspect: (Entry & { notHeard: number; listeners: number })[];
  /** Always-on stations with no answers at all in ACTIVITY_WINDOW_MS: no evidence either way, listed for information. */
  quiet: Entry[];
  priyom: {
    /**
     * This server's fetch: when its copy was fetched (ISO), and what's wrong with it: no copy, a
     * refresh failing behind an old copy, or a copy over PRIYOM_COPY_STALE_MS old. Null when fine.
     */
    fetchedAt: string | null;
    error: string | null;
    /** What's wrong with the shared record: never saved, or not saved by any server in PRIYOM_RECORD_STALE_MS. Null when fine. */
    tracking: string | null;
    /** The shared record (any server): when a fetch last changed a catalog station's slots, and since when that's been tracked. */
    changedAt: string | null;
    trackedSince: string | null;
    /** No change seen in PRIYOM_UNCHANGED_MS. */
    unchanged: boolean;
    /** Catalog designators with no transmissions in this server's copy (null: no copy to look in). */
    missing: (Entry & { designator: string })[] | null;
  };
  /** Nothing for a person to do: no stale or suspect entry, and Priyom's feed fetched, recorded, changing, and listing every designator. */
  empty: boolean;
};

export type FreshnessInput = {
  now: number;
  /** Signal-station answers of the last ACTIVITY_WINDOW_MS, per station, outcome and listener. */
  tallies: readonly AnswerTally[];
  /** This server's Priyom copy (null: none) and its fetch status. */
  schedule: { transmissions: readonly PriyomTx[] } | null;
  fetch: { fetchedAt: number | null; error: string | null };
  /** The shared record, or null before the first good fetch was recorded. */
  feed: Pick<PriyomFeedRecord, "trackedSince" | "changedAt" | "fetchedAt"> | null;
  stations?: readonly SignalStation[];
};

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const entry = (s: SignalStation): Entry => ({ slug: s.slug, name: s.name, sources: s.sources });

export function freshnessReport({ now, tallies, schedule, fetch, feed, stations = SIGNAL_STATIONS }: FreshnessInput): FreshnessReport {
  // Whole UTC days since the checked date, so the hour the report runs doesn't matter.
  const stale = stations.flatMap((s) => {
    const days = Math.floor((now - Date.parse(`${s.checked}T00:00:00Z`)) / DAY);
    return days * DAY > CHECKED_STALE_MS ? [{ ...entry(s), checked: s.checked, days }] : [];
  });
  const suspect: FreshnessReport["suspect"] = [];
  const quiet: Entry[] = [];
  for (const s of stations) {
    const a = stationActivity(s, tallies);
    if (a?.status === "suspect") suspect.push({ ...entry(s), notHeard: a.notHeard, listeners: a.notHeardListeners });
    else if (a?.status === "quiet") quiet.push(entry(s));
  }
  const missing = schedule
    ? stations.flatMap((s) =>
        s.priyom && s.schedule.kind !== "defunct" && !schedule.transmissions.some((t) => t.station === s.priyom)
          ? [{ ...entry(s), designator: s.priyom }]
          : [],
      )
    : null;
  const unchanged = feed !== null && priyomUnchanged(feed, now);
  // A server keeps serving its last good copy while refreshes fail (#147 review, owner D1):
  // the failure and the copy's age are reported, so an old copy can't read as a working feed.
  let error: string | null = null;
  if (!schedule) error = fetch.error ?? "no copy of Priyom's schedule yet";
  else if (fetch.error) error = `${fetch.error} (still serving a copy from ${iso(fetch.fetchedAt) ?? "an unknown time"})`;
  else if (fetch.fetchedAt === null || now - fetch.fetchedAt > PRIYOM_COPY_STALE_MS)
    error = `this server's copy is from ${iso(fetch.fetchedAt) ?? "an unknown time"}, over a day old`;
  // Without the shared record, the 45-day "unchanged" check can't run: say so instead of staying quiet.
  const tracking = !feed
    ? "no server has saved a Priyom fetch yet, so changes aren't being tracked"
    : now - feed.fetchedAt > PRIYOM_RECORD_STALE_MS
      ? `no server has saved a Priyom fetch since ${iso(feed.fetchedAt)}`
      : null;
  const priyom = {
    fetchedAt: iso(fetch.fetchedAt),
    error,
    tracking,
    changedAt: iso(feed?.changedAt ?? null),
    trackedSince: iso(feed?.trackedSince ?? null),
    unchanged,
    missing,
  };
  const empty = !stale.length && !suspect.length && !error && !tracking && !unchanged && !missing?.length;
  return { at: new Date(now).toISOString(), stale, suspect, quiet, priyom, empty };
}

const day = (isoTime: string) => isoTime.slice(0, 10);
const links = (sources: readonly string[]) => sources.map((u) => `<${u}>`).join(", ") || "no sources listed";
const DAYS = (ms: number) => Math.round(ms / DAY);

/** The freshness issue's body: a to-do list, one line per thing to look at, each with where to check it. */
export function freshnessIssueBody(r: FreshnessReport): string {
  const out: string[] = [
    `Weekly check of the signal stations catalog (\`apps/web/src/lib/signal-stations.ts\`, #147), ${day(r.at)}.`,
    "After checking an entry against its sources, fix what's wrong and bump its `checked` date. This issue is updated each Monday and closes itself when nothing is left.",
  ];
  if (r.stale.length) {
    out.push("", `### Not checked in ${DAYS(CHECKED_STALE_MS)} days`);
    for (const s of r.stale) out.push(`- [ ] **${s.name}** (\`${s.slug}\`): last checked ${s.checked}, ${s.days} days ago. Sources: ${links(s.sources)}`);
  }
  if (r.suspect.length) {
    out.push("", `### Possibly off the air`, `No one said they heard these in ${DAYS(ACTIVITY_WINDOW_MS)} days, and at least ${SUSPECT_MIN_NOT_HEARD} answers from ${SUSPECT_MIN_LISTENERS}+ listeners said they didn't. Could be propagation; check before changing anything.`);
    for (const s of r.suspect)
      out.push(`- [ ] **${s.name}** (\`${s.slug}\`): ${s.notHeard} "not heard" from ${s.listeners} listeners, no "heard". Sources: ${links(s.sources)}`);
  }
  const p = r.priyom;
  const priyomLines: string[] = [];
  if (p.error) priyomLines.push(`- [ ] Priyom's schedule isn't loading: ${p.error}. Last good copy on this server: ${p.fetchedAt ?? "none"}. <${PRIYOM_SCHEDULE_PAGE}>`);
  if (p.tracking)
    priyomLines.push(`- [ ] Priyom change tracking isn't working: ${p.tracking}. Check the server log for "signals.priyom: not recorded" and the PriyomFeed table.`);
  if (p.unchanged)
    priyomLines.push(
      `- [ ] Priyom's schedule may not be maintained: no change to the catalog stations' slots since ${p.changedAt ? day(p.changedAt) : `tracking began ${day(p.trackedSince!)}`} (over ${DAYS(PRIYOM_UNCHANGED_MS)} days). <${PRIYOM_SCHEDULE_PAGE}>`,
    );
  for (const s of p.missing ?? [])
    priyomLines.push(`- [ ] **${s.name}** (\`${s.slug}\`): no ${s.designator} transmissions in Priyom's schedule this week; Priyom may have dropped or retired it. Sources: ${links(s.sources)}`);
  if (priyomLines.length) out.push("", "### Priyom", ...priyomLines);
  if (r.quiet.length)
    out.push("", `### No answers in ${DAYS(ACTIVITY_WINDOW_MS)} days (for information)`, `Nobody answered "Did you hear it?" about these, so there's no evidence either way: ${r.quiet.map((s) => s.name).join(", ")}.`);
  if (r.empty) out.push("", "Nothing needs a look this week.");
  return out.join("\n");
}
