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
import { readFileSync, writeFileSync } from "node:fs";
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
 * replaces.
 */
export async function snapshot(season: string, fetchImpl: typeof fetch = fetch, previous?: SiteTable) {
  const csv = await latin1(scheduleUrl(season), fetchImpl);
  const count = parseEibi(csv, season).length; // throws if it isn't the schedule
  const sites = parseSites(await latin1(SITES_URL, fetchImpl), previous); // throws if it isn't the whole table
  return { json: JSON.stringify({ season, csv, sites: sitesToJson(sites) }) + "\n", count, siteCount: sites.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const season = process.argv[2] ?? seasonFor(Date.now());
  const file = new URL("../src/server/eibi-snapshot.json", import.meta.url);
  // The bundled table is the last good one; a snapshot from before #72 has none.
  const bundled = JSON.parse(readFileSync(file, "utf8")).sites;
  const { json, count, siteCount } = await snapshot(season, fetch, bundled ? sitesFromJson(bundled) : undefined);
  writeFileSync(file, json);
  console.log(`Saved ${season}: ${count} broadcasts, ${siteCount} transmitter sites.`);
}
