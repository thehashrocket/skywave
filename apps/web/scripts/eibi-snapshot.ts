/**
 * Refreshes the bundled EiBi schedule (src/server/eibi-snapshot.json), the
 * copy the server falls back on when eibispace.de can't be reached. Run it
 * once each season changes (late March and late October):
 *
 *   pnpm eibi:snapshot          # the season it is now
 *   pnpm eibi:snapshot b26      # a given season
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEibi, scheduleUrl, seasonFor } from "../src/lib/eibi";

/** A season's file as the snapshot's JSON, checked to be the schedule. */
export async function snapshot(season: string, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl(scheduleUrl(season), { redirect: "error" });
  if (!res.ok) throw new Error(`${scheduleUrl(season)}: HTTP ${res.status}`);
  // The file is Latin-1.
  const csv = new TextDecoder("latin1").decode(await res.arrayBuffer());
  const count = parseEibi(csv, season).length; // throws if it isn't the schedule
  return { json: JSON.stringify({ season, csv }) + "\n", count };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const season = process.argv[2] ?? seasonFor(Date.now());
  const { json, count } = await snapshot(season);
  writeFileSync(new URL("../src/server/eibi-snapshot.json", import.meta.url), json);
  console.log(`Saved ${season}: ${count} broadcasts.`);
}
