/**
 * Refreshes the bundled EiBi schedule and transmitter-site table
 * (src/server/eibi-snapshot.json), the copies the server falls back on when
 * eibispace.de can't be reached. Run it
 * once each season changes (late March and late October; the
 * `Refresh EiBi snapshot` workflow does this on 1 April and 1 November):
 *
 *   pnpm eibi:snapshot          # the season it is now
 *   pnpm eibi:snapshot b26      # a given season
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEibi, scheduleUrl, seasonFor } from "../src/lib/eibi";
import { parseSites, SITES_URL, sitesFromJson, sitesToJson, type SiteTable } from "../src/lib/eibi-sites";
import { readCapped } from "../src/server/read-capped";

/**
 * How long one of EiBi's files may take, body included, before the run gives
 * up on it. Longer than the server's 10 s: nobody is waiting on this job, but a
 * stalled download mustn't hold it for GitHub's six hours either.
 */
export const SNAPSHOT_FETCH_TIMEOUT_MS = 30_000;

/** The most one of EiBi's files may be, as on the server: today's schedule is about 0.5 MB and the README about 0.14 MB. */
export const SNAPSHOT_MAX_BYTES = 3_000_000;

/** One of EiBi's files as text (they're Latin-1). */
async function latin1(url: string, fetchImpl: typeof fetch, timeoutMs: number) {
  // The signal covers reading the body too, not just the response headers.
  const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await readCapped(res, SNAPSHOT_MAX_BYTES, url)).toString("latin1");
}

/**
 * A season's file and the site table as the snapshot's JSON, each checked to
 * be what it says; the site table also against `previous`, the bundled one it
 * replaces. A README that can't be fetched in time or is refused keeps `previous`, so
 * it never holds up the season's schedule (the server's offline fallback);
 * `sitesError` says why. With no `previous` there's nothing to keep, and it throws.
 */
export async function snapshot(
  season: string,
  fetchImpl: typeof fetch = fetch,
  previous?: SiteTable,
  timeoutMs = SNAPSHOT_FETCH_TIMEOUT_MS,
) {
  const csv = await latin1(scheduleUrl(season), fetchImpl, timeoutMs);
  const count = parseEibi(csv, season).length; // throws if it isn't the schedule
  let sites: SiteTable;
  let sitesError: string | undefined;
  try {
    sites = parseSites(await latin1(SITES_URL, fetchImpl, timeoutMs), previous); // throws if it isn't the whole table
  } catch (error) {
    if (!previous) throw error;
    sites = previous;
    sitesError = error instanceof Error ? error.message : String(error);
  }
  const json = JSON.stringify({ season, csv, sites: sitesToJson(sites) }) + "\n";
  return { json, count, siteCount: sites.size, previousSiteCount: previous?.size, sitesError };
}

/**
 * The site counts for the PR body, as a `site_counts` step output: the bundled
 * table's size and the new one's, so a table that shrinks season by season is
 * visible in review.
 */
export function siteCountsOutput(previous: number | undefined, now: number) {
  const n = (x: number) => x.toLocaleString("en-US");
  const line =
    previous === undefined ? `Transmitter sites: ${n(now)} (none bundled before).` : `Transmitter sites: ${n(previous)} → ${n(now)}.`;
  return `site_counts=${line}\n`;
}

/**
 * How a kept site table is made visible in GitHub Actions: a `::warning::`
 * annotation on the run, and a `sites_note` step output the workflow puts in
 * the PR body, so a README that keeps failing can't freeze sites unnoticed.
 */
export function keptSitesNotice(sitesError: string) {
  const note = `Kept the bundled transmitter sites: ${sitesError}`.replace(/[\r\n]+/g, " ");
  return { warning: `::warning title=EiBi transmitter sites not refreshed::${note}`, output: `sites_note=${note}\n` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const season = process.argv[2] ?? seasonFor(Date.now());
  const file = new URL("../src/server/eibi-snapshot.json", import.meta.url);
  // The bundled table is the last good one; a snapshot from before #72 has none.
  const bundled = JSON.parse(readFileSync(file, "utf8")).sites;
  const { json, count, siteCount, previousSiteCount, sitesError } = await snapshot(
    season,
    fetch,
    bundled ? sitesFromJson(bundled) : undefined,
  );
  const outputs = [siteCountsOutput(previousSiteCount, siteCount)];
  if (sitesError) {
    const { warning, output } = keptSitesNotice(sitesError);
    console.log(warning);
    outputs.push(output);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs.join(""));
  writeFileSync(file, json);
  console.log(`Saved ${season}: ${count} broadcasts, ${siteCount} transmitter sites.`);
}
