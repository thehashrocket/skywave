/**
 * EiBi's target-area names: where a broadcast is aimed ("to Europe", "to
 * China"). The schedule's target column holds either a target-area code from
 * the README's "III) Target-area codes" section ("Eu", "SEA", built with its
 * prefix rules: "C.. - Central .." makes "CEu" Central Europe) or an ITU
 * country code from "II) Country codes" ("CHN", "B"). Parsed from the README
 * by the snapshot script and bundled with the schedule (station search,
 * re-check D5), so the names come from EiBi each season instead of by hand.
 *
 * README: http://www.eibispace.de/dx/README.TXT (the file SITES_URL names).
 */

/** Target names as bundled: area codes, country codes and the one-letter prefixes ("C" → "Central"). */
export type TargetTable = {
  areas: Record<string, string>;
  countries: Record<string, string>;
  prefixes: Record<string, string>;
};

/**
 * Codes the schedule uses that EiBi's README never defines, so they show no
 * target line and the bundled-snapshot test accepts them. Any other unnamed
 * code still fails that test and is listed in the snapshot PR.
 * "Tas": 3 rows of VMC Charleville Met Fax (AUS) in b26.
 */
export const UNNAMED_TARGETS: ReadonlySet<string> = new Set(["Tas"]);

/** Fewest names a README can give and still count as whole: the 2026-11-22 file has 289 countries and 35 areas. */
export const MIN_COUNTRIES = 200;
export const MIN_AREAS = 25;
/** Against the last good table, the share a new one must keep (as for transmitter sites). */
export const MIN_TARGET_SHARE = 0.8;

// The contents line reads "II)  Country codes." with two spaces and the section one. The
// contents line for III is spelled like its section, so III is looked for after II.
const COUNTRY_SECTION = /^\s*II\) Country codes\./;
const AREA_SECTION = /^\s*III\) Target-area codes\./;
const COUNTRY_LINE = /^ {3}([A-Z0-9]{1,4})\*? +(\S.*)$/;
const AREA_LINE = /^ {3}(\S{1,4})\s+- (\S.*)$/;
const PREFIX = /^([A-Z])\.\.$/;

/**
 * A name as it reads after "to": without EiBi's trailing note in brackets
 * ("Europe (often including North Africa/Middle East)" is "Europe") or the
 * plural hint ("America(s)" is "America").
 */
function cleanName(name: string): string {
  return name
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\(s\)/g, "")
    .trim();
}

const size = (t: TargetTable) => Object.keys(t.countries).length + Object.keys(t.areas).length;

/**
 * The target names from the README's text. Throws if either section is
 * missing or short: under MIN_COUNTRIES or MIN_AREAS, or under
 * MIN_TARGET_SHARE of `previous` (the last good table), so a cut-off or moved
 * file never replaces good names.
 */
export function parseTargets(readme: string, previous?: TargetTable): TargetTable {
  const lines = readme.split(/\r?\n/);
  const countryAt = lines.findIndex((l) => COUNTRY_SECTION.test(l));
  const areaAt = countryAt < 0 ? -1 : lines.findIndex((l, i) => i > countryAt && AREA_SECTION.test(l));
  if (areaAt < 0) throw new Error("Not EiBi's README: no country or target-area section.");

  const countries: Record<string, string> = {};
  for (const line of lines.slice(countryAt + 1, areaAt)) {
    const m = COUNTRY_LINE.exec(line);
    if (m) countries[m[1]!] = cleanName(m[2]!);
  }
  const areas: Record<string, string> = {};
  const prefixes: Record<string, string> = {};
  for (const line of lines.slice(areaAt + 1)) {
    if (!line.trim()) break; // the list ends at the first blank line
    const m = AREA_LINE.exec(line);
    if (!m) continue;
    const prefix = PREFIX.exec(m[1]!);
    if (prefix) prefixes[prefix[1]!] = m[2]!.replace(/\s*\.\.$/, "").trim();
    else areas[m[1]!] = cleanName(m[2]!);
  }

  const table = { areas, countries, prefixes };
  const nCountries = Object.keys(countries).length;
  const nAreas = Object.keys(areas).length;
  if (nCountries < MIN_COUNTRIES || nAreas < MIN_AREAS)
    throw new Error(
      `EiBi README refused: ${nCountries} country and ${nAreas} target-area names, under the floor of ${MIN_COUNTRIES} and ${MIN_AREAS}.`,
    );
  if (previous && size(table) < size(previous) * MIN_TARGET_SHARE)
    throw new Error(
      `EiBi README refused: ${size(table)} target names, under ${MIN_TARGET_SHARE * 100}% of the bundled ${size(previous)}.`,
    );
  return table;
}

/**
 * A target code's name: an area ("Eu" → "Europe"), a prefixed area ("WAf" →
 * "West Africa"), or a country ("CHN" → "China"). Undefined for a blank or
 * unknown code.
 */
export function targetName(table: TargetTable, code: string): string | undefined {
  const c = code.trim();
  if (!c) return undefined;
  // Own keys only: a code like "constructor" mustn't name itself after Object's.
  const own = (names: Record<string, string>, key: string) => (Object.hasOwn(names, key) ? names[key] : undefined);
  const direct = own(table.areas, c) ?? own(table.countries, c);
  if (direct) return direct;
  const prefix = own(table.prefixes, c[0]!);
  const rest = own(table.areas, c.slice(1));
  return prefix && rest ? `${prefix} ${rest}` : undefined;
}

/** Codes in `codes` that have no name and aren't known to be unnamed: what the snapshot PR lists. */
export function unnamedTargets(table: TargetTable, codes: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const code of codes) {
    const c = code.trim();
    if (c && !UNNAMED_TARGETS.has(c) && targetName(table, c) === undefined) out.add(c);
  }
  return [...out].sort();
}
