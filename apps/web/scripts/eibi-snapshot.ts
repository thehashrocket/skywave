/**
 * Refreshes the bundled EiBi schedule, transmitter-site table and target names
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
import { parseTargets, type TargetTable, unnamedTargets } from "../src/lib/eibi-targets";
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
 * A season's file, the site table and the target names as the snapshot's
 * JSON, each checked to be what it says; the site table and target names also
 * against `previous` and `previousTargets`, the bundled ones they replace. A
 * README that can't be fetched in time or is refused keeps the bundled table,
 * so it never holds up the season's schedule (the server's offline fallback);
 * `sitesError` and `targetsError` say why. With no bundled site table there's
 * nothing to keep, and it throws; with no bundled target names, none are saved.
 * `unnamed` lists the season's target codes with no name (station search,
 * re-check D3), for the PR body.
 */
export async function snapshot(
  season: string,
  fetchImpl: typeof fetch = fetch,
  previous?: SiteTable,
  timeoutMs = SNAPSHOT_FETCH_TIMEOUT_MS,
  previousTargets?: TargetTable,
) {
  const csv = await latin1(scheduleUrl(season), fetchImpl, timeoutMs);
  const listed = parseEibi(csv, season); // throws if it isn't the schedule
  let readme: string | undefined;
  let readmeError: unknown;
  try {
    readme = await latin1(SITES_URL, fetchImpl, timeoutMs);
  } catch (error) {
    readmeError = error;
  }
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  let sites: SiteTable;
  let sitesError: string | undefined;
  try {
    if (readme === undefined) throw readmeError;
    sites = parseSites(readme, previous); // throws if it isn't the whole table
  } catch (error) {
    if (!previous) throw error;
    sites = previous;
    sitesError = message(error);
  }

  let targets: TargetTable | undefined;
  let targetsError: string | undefined;
  try {
    if (readme === undefined) throw readmeError;
    targets = parseTargets(readme, previousTargets); // throws if either section is missing or short
  } catch (error) {
    targets = previousTargets;
    targetsError = message(error);
  }

  const unnamed = targets ? unnamedTargets(targets, listed.map((b) => b.target)) : [];
  const json = JSON.stringify({ season, csv, sites: sitesToJson(sites), ...(targets && { targets }) }) + "\n";
  return {
    json,
    count: listed.length,
    siteCount: sites.size,
    previousSiteCount: previous?.size,
    sitesError,
    targetsError,
    unnamed,
  };
}

/**
 * The target-name note for the PR body, as a `targets_note` step output: why
 * the bundled names were kept, and any of the season's codes with no name, so
 * a new EiBi code is seen before the snapshot merges (CI doesn't run on the
 * workflow's PR). Empty when there's nothing to say.
 */
export function targetsNoteOutput(targetsError: string | undefined, unnamed: readonly string[]) {
  const parts = [];
  if (targetsError) parts.push(`Kept the bundled target names: ${targetsError}`.replace(/[\r\n]+/g, " "));
  // In code spans: a code from the remote schedule can't @-mention anyone or render as Markdown in the bot's PR.
  if (unnamed.length) parts.push(`Target codes with no name in EiBi's README: ${unnamed.map((c) => `\`${c.replace(/`/g, "")}\``).join(", ")}.`);
  return parts.length ? `targets_note=${parts.join(" ")}\n` : "";
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
  // The bundled tables are the last good ones; a snapshot from before #72 has no sites, one
  // from before station search no target names.
  const bundled = JSON.parse(readFileSync(file, "utf8"));
  const { json, count, siteCount, previousSiteCount, sitesError, targetsError, unnamed } = await snapshot(
    season,
    fetch,
    bundled.sites ? sitesFromJson(bundled.sites) : undefined,
    SNAPSHOT_FETCH_TIMEOUT_MS,
    bundled.targets,
  );
  const outputs = [siteCountsOutput(previousSiteCount, siteCount), targetsNoteOutput(targetsError, unnamed)];
  if (sitesError) {
    const { warning, output } = keptSitesNotice(sitesError);
    console.log(warning);
    outputs.push(output);
  }
  if (targetsError) console.log(`::warning title=EiBi target names not refreshed::${targetsError.replace(/[\r\n]+/g, " ")}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs.join(""));
  writeFileSync(file, json);
  console.log(`Saved ${season}: ${count} broadcasts, ${siteCount} transmitter sites.`);
}
