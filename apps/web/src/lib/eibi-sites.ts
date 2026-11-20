/**
 * EiBi's transmitter sites (issue #72): where each broadcast in the schedule
 * is sent from. The schedule CSV gives a site code in its Remarks column;
 * the README's "IV) Transmitter site codes" section maps codes to places and
 * coordinates. The table is server-only: the page never receives a site
 * (#72 eng review, D7/D13). `siteKey` is shared, since lib/eibi.ts keys each
 * row as it parses.
 *
 * README: http://www.eibispace.de/dx/README.TXT (one file, not per season).
 */

/** Where EiBi's site table is published. Plain http, like the schedule. */
export const SITES_URL = "http://www.eibispace.de/dx/README.TXT";

/**
 * With no earlier table to compare against, fewer sites than this and the
 * README is treated as broken (cut off, or an error page that happens to
 * carry the header): the 2026-11-19 file lists about 1,700 (#72 eng review,
 * D11).
 */
export const MIN_SITES = 1_000;

/**
 * Against the last good table (the bundled one counts), a new one must keep
 * at least this share of its sites: EiBi adds and drops a few between
 * versions, while a download cut off mid-table loses far more.
 */
export const MIN_SHARE = 0.8;

/**
 * The most coordinates one site keeps. A site with several is a group of
 * transmitters (the 2026-11-19 README's largest has 6); the cap bounds what
 * each answer saves in txSites if a broken README runs one entry on and on.
 */
export const MAX_SITE_COORDS = 20;

/** One site code: its host country (ITU code) and every coordinate EiBi lists for it, as [lat, lon]. */
export type Site = { country: string; coords: [number, number][] };

/**
 * Sites by key: "ITU-code" for a coded site ("RUS-s", case-sensitive: CHN
 * "b" and "B" are different places), or "ITU" alone for a country's only or
 * default site ("AFS: Meyerton ... except:").
 */
export type SiteTable = ReadonlyMap<string, Site>;

const SECTION = /^\s*IV\) Transmitter site codes/;
const COUNTRY_LINE = /^ {3}([A-Z]{1,3}):\s*(.*)$/;
const MORE_LINE = /^ {4,}(\S.*)$/;
const CODED = /^([A-Za-z0-9]{1,3})-(.*)$/;
// 34N32-69E20, 26S07'40"-28E12'20", and the file's slips: a missing dash
// (20S05'06"146E15'34") or a stray space (20S 43'31"-139E29'14").
const COORD = /(\d{1,2})([NS])\s?(\d{2})(?:'(\d{2})")?-?(\d{1,3})([EW])(\d{2})(?:'(\d{2})")?/g;

function coordsIn(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(COORD)) {
    const [, latD, ns, latM, latS, lonD, ew, lonM, lonS] = m;
    if (Number(latM) >= 60 || Number(lonM) >= 60 || Number(latS ?? 0) >= 60 || Number(lonS ?? 0) >= 60) continue;
    const lat = (Number(latD) + Number(latM) / 60 + Number(latS ?? 0) / 3600) * (ns === "S" ? -1 : 1);
    const lon = (Number(lonD) + Number(lonM) / 60 + Number(lonS ?? 0) / 3600) * (ew === "W" ? -1 : 1);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    out.push([Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4]);
  }
  return out;
}

/**
 * The site table from the README's text. Throws if the file has no site
 * section, or too few sites to be whole: under MIN_SHARE of `previous` (the
 * last good table), or under MIN_SITES when there is none. A moved, cut-off
 * or broken file never replaces a good table; the error gives both counts.
 */
export function parseSites(readme: string, previous?: SiteTable): SiteTable {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((l) => SECTION.test(l));
  if (start < 0) throw new Error("Not EiBi's README: no transmitter site section.");
  const sites = new Map<string, Site>();
  let country: string | null = null;
  let last: Site | null = null;
  for (const line of lines.slice(start + 1)) {
    let body: string;
    const head = COUNTRY_LINE.exec(line);
    if (head) {
      country = head[1]!;
      body = head[2]!;
    } else {
      const more = MORE_LINE.exec(line);
      if (!more || !country) continue;
      body = more[1]!;
    }
    if (!body) continue;
    const coded = CODED.exec(body);
    if (!coded) {
      if (head) {
        // A country's only or default site, on the country's own line.
        last = { country, coords: coordsIn(body) };
        sites.set(country, last);
      } else if (last) {
        // A wrapped line: more of the entry above.
        last.coords.push(...coordsIn(body));
      }
      continue;
    }
    last = { country, coords: coordsIn(coded[2]!) };
    sites.set(`${country}-${coded[1]}`, last);
  }
  // After wrapped lines, so a long group is capped as a whole.
  for (const site of sites.values()) site.coords.length = Math.min(site.coords.length, MAX_SITE_COORDS);
  if (previous && sites.size < previous.size * MIN_SHARE)
    throw new Error(
      `EiBi README refused: ${sites.size} transmitter sites, under ${MIN_SHARE * 100}% of the largest good table's ${previous.size}.`,
    );
  if (!previous && sites.size < MIN_SITES)
    throw new Error(
      `EiBi README refused: ${sites.size} transmitter sites, under the first-parse floor of ${MIN_SITES}.`,
    );
  return sites;
}

/**
 * A schedule row's site key from its ITU (station country) and Remarks
 * fields: "s" is a site in the station's own country ("RUS-s"; EiBi
 * occasionally writes it "-s"), "/ABC" or "/ABC-s" one in host country ABC,
 * and a blank the country's default site if it has one. Undefined when
 * Remarks isn't a site code.
 */
export function siteKey(itu: string, remark: string): string | undefined {
  const r = remark.trim();
  if (!r) return itu || undefined;
  const host = /^\/([A-Z]{1,3})(?:-([A-Za-z0-9]{1,3}))?$/.exec(r);
  if (host) return host[2] ? `${host[1]}-${host[2]}` : host[1];
  const own = /^-?([A-Za-z0-9]{1,3})$/.exec(r);
  return own && itu ? `${itu}-${own[1]}` : undefined;
}

/**
 * What an answer saves about one candidate transmitter (txSites, #72 eng
 * review D8/D12): the key and every listed coordinate, empty when EiBi gives
 * none; `key: null` with the country when EiBi doesn't say which site.
 */
export type SiteCandidate = { key: string; coords: [number, number][] } | { key: null; country: string; coords: [] };

/**
 * One site key looked up, as one of three outcomes: a placed site, a code
 * the table doesn't know (key kept, no coordinates), or EiBi not saying which
 * site (no key, or a country-only key with no default site).
 */
export function candidateFor(sites: SiteTable, key: string | undefined, country: string): SiteCandidate {
  const site = key ? sites.get(key) : undefined;
  if (site) return { key: key!, coords: site.coords };
  if (!key?.includes("-")) return { key: null, country: key ?? country, coords: [] };
  return { key, coords: [] };
}

/** Orders [key, value] entries by key, the same on every machine, so a stored row or file doesn't churn. */
export function byKey([a]: [string, unknown], [b]: [string, unknown]): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The table as JSON for the bundled snapshot, and back (sitesToJson writes Site shapes, so no conversion). */
export function sitesToJson(sites: SiteTable): Record<string, Site> {
  return Object.fromEntries([...sites].sort(byKey));
}

export function sitesFromJson(json: Record<string, unknown>): SiteTable {
  return new Map(Object.entries(json) as [string, Site][]);
}
