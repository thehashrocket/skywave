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

/** One of EiBi's files as text (they're Latin-1). */
async function latin1(url: string, fetchImpl: typeof fetch) {
  const res = await fetchImpl(url, { redirect: "error" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new TextDecoder("latin1").decode(await res.arrayBuffer());
}

/**
 * A season's file and the site table as the snapshot's JSON, each checked to
 * be what it says; the site table also against `previous`, the bundled one it
 * replaces. A README that can't be fetched or is refused keeps `previous`, so
 * it never holds up the season's schedule (the server's offline fallback);
 * `sitesError` says why. With no `previous` there's nothing to keep, and it throws.
 */
export async function snapshot(season: string, fetchImpl: typeof fetch = fetch, previous?: SiteTable) {
  const csv = await latin1(scheduleUrl(season), fetchImpl);
  const count = parseEibi(csv, season).length; // throws if it isn't the schedule
  let sites: SiteTable;
  let sitesError: string | undefined;
  try {
    sites = parseSites(await latin1(SITES_URL, fetchImpl), previous); // throws if it isn't the whole table
  } catch (error) {
    if (!previous) throw error;
    sites = previous;
    sitesError = error instanceof Error ? error.message : String(error);
  }
  const json = JSON.stringify({ season, csv, sites: sitesToJson(sites) }) + "\n";
  return { json, count, siteCount: sites.size, sitesError };
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
  const { json, count, siteCount, sitesError } = await snapshot(
    season,
    fetch,
    bundled ? sitesFromJson(bundled) : undefined,
  );
  if (sitesError) {
    const { warning, output } = keptSitesNotice(sitesError);
    console.log(warning);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  }
  writeFileSync(file, json);
  console.log(`Saved ${season}: ${count} broadcasts, ${siteCount} transmitter sites.`);
}
