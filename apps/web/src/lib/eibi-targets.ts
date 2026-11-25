import { inRegion, type Region } from "./ghostnet";

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

/** EiBi's spellings we show differently (#117). */
const RESPELLED: Readonly<Record<string, string>> = { "Bangla Desh": "Bangladesh" };

/**
 * A README name as a row or the area filter shows it: without EiBi's trailing
 * " *" footnote marker ("Taiwan *" is "Taiwan"), then without the bracketed
 * note the marker hid from cleanName ("Ogasawara (Bonin, Iwo Jima) *" is
 * "Ogasawara"), and in the usual spelling ("Bangla Desh" is "Bangladesh").
 * Applied when names are read, so the bundled table stays as EiBi wrote it (#117).
 */
export function displayName(name: string): string {
  const bare = cleanName(name.replace(/\s*\*$/, "")) || name;
  return Object.hasOwn(RESPELLED, bare) ? RESPELLED[bare]! : bare;
}

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
  if (direct) return displayName(direct);
  const prefix = own(table.prefixes, c[0]!);
  const rest = own(table.areas, c.slice(1));
  return prefix && rest ? displayName(`${prefix} ${rest}`) : undefined;
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

/**
 * The broad regions the area filter offers first (#109), in its order. A
 * target code maps to a set of them: "Am" is aimed at both Americas, "RUS"
 * at Europe and Asia (eng D4).
 */
export type BroadRegion = "na" | "eu" | "as" | "af" | "me" | "oc" | "la";
export const BROAD_REGIONS: readonly { id: BroadRegion; name: string }[] = [
  { id: "na", name: "North America" },
  { id: "eu", name: "Europe" },
  { id: "as", name: "Asia" },
  { id: "af", name: "Africa" },
  { id: "me", name: "Middle East" },
  { id: "oc", name: "Oceania" },
  { id: "la", name: "Latin America" },
];
const ALL_REGIONS: readonly BroadRegion[] = BROAD_REGIONS.map((r) => r.id);

/** A broad region's name ("North America"). */
export const regionName = (id: BroadRegion) => BROAD_REGIONS.find((r) => r.id === id)!.name;

/** Whether a stored string is one of the broad regions' ids. */
export const isBroadRegion = (id: string): id is BroadRegion => (ALL_REGIONS as readonly string[]).includes(id);

/** EiBi's compass targets ("NE", "WNW"): a direction from the transmitter, so no region without knowing where it is. */
const COMPASS = ["ENE", "ESE", "NE", "NNE", "NNW", "NW", "SE", "SSE", "SSW", "SW", "WNW", "WSW"];

/** Target-area codes (README section III) and the regions they're aimed at; compass codes have none. */
const AREA_REGIONS: Record<string, readonly BroadRegion[]> = {
  Af: ["af"],
  Am: ["na", "la"],
  As: ["as"],
  Car: ["la", "na"],
  Cau: ["eu", "as"],
  CIS: ["eu", "as"],
  CNA: ["na"],
  ENA: ["na"],
  Eu: ["eu"],
  FE: ["as"],
  Glo: ALL_REGIONS,
  In: ["as"],
  LAm: ["la"],
  ME: ["me"],
  NAO: ["na", "eu"],
  Oc: ["oc"],
  SAO: ["la", "af"],
  SEA: ["as"],
  SEE: ["eu"],
  Sib: ["as"],
  Tib: ["as"],
  WIO: ["af", "as"],
  WNA: ["na"],
  ...Object.fromEntries(COMPASS.map((c) => [c, []])),
};

/** Prefixed areas whose region isn't the bare area's ("NAm" is North America, not both Americas). */
const PREFIXED_REGIONS: Record<string, readonly BroadRegion[]> = {
  NAm: ["na"],
  CAm: ["la"],
  SAm: ["la"],
  NAf: ["af", "me"],
};

/**
 * ITU country codes (README section II) by region. A code listed under two
 * regions is in both ("RUS", "TUR", "EGY"). Coarse on purpose: the filter
 * asks where a broadcast is aimed, not where it's heard.
 */
const COUNTRIES_BY_REGION: Record<BroadRegion, string> = {
  na: "ALS BER CAN CG7 GRL HWA SPM USA",
  la:
    "ABW AIA ARG ATG ATN B BAH BES BLM BLZ BOL BRB CHL CLM CPT CTR CUB CUW CYM DMA DOM EQA FLK GLP GPG GRD GTM GUF " +
    "GUY HND HTI JMC JUF KNA LCA MAF MEX MRT MSR NCG PAQ PNR PRG PRU PTR SAP SLV SUR SXM TCA TRD URG VCT VEN VIR VRG",
  eu:
    "ALB AND AUT AZR BEL BIH BLR BUL CNR CVA CYP CZE D DNK E EST F FIN FRO G GEO ARM AZE GIB GRC HNG HOL HRV I IRL " +
    "ISL JMY KAL KOS LIE LTU LUX LVA MCO MDA MDR MKD MLT MNE NOR POL POR ROU RUS S SMR SRB SUI SVB SVK SVN TUR UKR",
  as:
    "AFG ARM AZE BGD BRU BTN CBG CHN CLN GEO HKG IND INS IWA J KAZ KGZ KOR KRE LAO MAC MLA MLD MNG MYA NPL PAK PHL " +
    "PRV RUS SNG THA TJK TKM TLS TWN UZB VTN XSP",
  af:
    "AFS AGL ALG AOE ASC BDI BEN BFA BIO BOT CAB CAF CEU CME COD COG COM CPV CTI DJI EGY ERI ETH EUR GAB GHA GMB GNB " +
    "GNE GUI JDN KEN LBR LBY LSO MAU MDG MEL MLI MOZ MRC MRN MTN MWI MYT NGR NIG NMB REU ROD RRW SDN SEN SEY SHN SOM " +
    "SRL SSD STP SWZ TCD TGO TRC TUN TZA UGA XBY ZMB ZWE",
  me: "ARS BHR EGY IRN IRQ ISR JOR KWT LBN OMA PSE QAT SYR TUR UAE XGZ XWB YEM",
  oc:
    "AUS CHR CKH FJI FSM GUM HWL ICO JAR JON KIR MDW MHL MRA NCL NFK NIU NRU NZL OCE PHX PLM PLW PNG PTC SLM SMA SMO " +
    "TKL TON TUV VUT WAK WAL",
};
const COUNTRY_REGIONS = new Map<string, BroadRegion[]>();
for (const id of ALL_REGIONS)
  for (const code of COUNTRIES_BY_REGION[id].split(" "))
    COUNTRY_REGIONS.set(code, [...(COUNTRY_REGIONS.get(code) ?? []), id]);

/**
 * Codes with no region, known and accepted: the compass targets, "Tas" (no
 * name either, see UNNAMED_TARGETS), and countries that are oceans, poles or
 * not places (Antarctica, International Waters, Clandestine, Unidentified...).
 * Rows aimed at them show under Any and under their own code. Any other code
 * in use with no region fails the bundled-snapshot test.
 */
export const UNREGIONED: ReadonlySet<string> = new Set([
  ...COMPASS,
  "Tas",
  ..."AMS ATA BVT CLA CRO HMD IW KER SGA SOK SSI UN XUU".split(" "),
]);

/** The broad regions a target code is aimed at; none for a blank, compass or unknown code. */
export function regionsOf(code: string): readonly BroadRegion[] {
  const c = code.trim();
  if (!c) return [];
  const own = <T>(table: Record<string, T>, key: string) => (Object.hasOwn(table, key) ? table[key] : undefined);
  const direct = own(AREA_REGIONS, c) ?? own(PREFIXED_REGIONS, c) ?? COUNTRY_REGIONS.get(c);
  if (direct) return direct;
  // A prefixed area ("WEu" is West Europe): the bare area's regions.
  return "CENSW".includes(c[0]!) ? (own(AREA_REGIONS, c.slice(1)) ?? []) : [];
}

/**
 * Where a receiver sits, as a broad region, for the area filter's suggestion
 * (eng D2, design 7A). Lat/lon boxes, coarse like GhostNet's (inRegion), tried
 * in order: the Middle East sits inside the Africa and Asia boxes, North
 * Africa's coast and New Guinea come before the Europe and Asia boxes that
 * would take them, and Latin America's top stops short of the US south. Undefined outside every box.
 */
const REGION_BOXES: readonly [BroadRegion, Region][] = [
  // The Middle East box reaches into the Caucasus and Central Asia: Georgia, Armenia and
  // Azerbaijan file under Europe first, Turkmenistan and its neighbours under Asia (north
  // of 37.3°N, so north-east Iran stays Middle East).
  ["eu", { name: "Caucasus", latMin: 38.3, latMax: 43.6, lonMin: 39.9, lonMax: 50.9 }],
  ["as", { name: "Central Asia", latMin: 37.3, latMax: 56, lonMin: 52, lonMax: 90 }],
  ["me", { name: "Middle East", latMin: 12, latMax: 42, lonMin: 34, lonMax: 63 }],
  // North Africa's coast reaches into the Europe box: Morocco below the Strait, then
  // Algeria and Tunisia east of Almeria (2°W) and west of Sicily and Malta (11.6°E).
  ["af", { name: "Morocco", latMin: 27, latMax: 35.95, lonMin: -13.5, lonMax: -1 }],
  ["af", { name: "Algeria and Tunisia", latMin: 30, latMax: 37.6, lonMin: -2, lonMax: 11.6 }],
  ["eu", { name: "Europe", latMin: 35, latMax: 72, lonMin: -25, lonMax: 45 }],
  ["af", { name: "Africa", latMin: -35, latMax: 37, lonMin: -18, lonMax: 52 }],
  ["oc", { name: "Oceania", latMin: -50, latMax: -11, lonMin: 110, lonMax: -130 }],
  // The Pacific islands, stopping short of Hawaii (US, so North America).
  ["oc", { name: "Oceania", latMin: -50, latMax: 25, lonMin: 160, lonMax: -161 }],
  // Papua New Guinea and the Solomons, east of Indonesian Papua, before the Asia box takes them.
  ["oc", { name: "New Guinea", latMin: -12, latMax: 0, lonMin: 140.8, lonMax: 160 }],
  ["as", { name: "Asia", latMin: -11, latMax: 78, lonMin: 45, lonMax: 180 }],
  ["la", { name: "Latin America", latMin: -56, latMax: 23, lonMin: -118, lonMax: -34 }],
  // Cuba and the Bahamas reach above 23°N; the Bahamas box stops east of Florida's coast.
  // Northern Mexico stays North America: no rectangle splits it from Texas and California.
  ["la", { name: "Cuba", latMin: 19.5, latMax: 23.3, lonMin: -85, lonMax: -74 }],
  ["la", { name: "Bahamas", latMin: 20.9, latMax: 27.3, lonMin: -79.3, lonMax: -72.5 }],
  ["na", { name: "North America", latMin: 15, latMax: 84, lonMin: -170, lonMax: -50 }],
];

export function broadRegionAt(lat: number, lon: number): BroadRegion | undefined {
  return REGION_BOXES.find(([, box]) => inRegion(box, lat, lon))?.[0];
}

/** One specific code the area filter offers after the broad regions. */
export type AreaCode = { code: string; name: string; stale: boolean };

/**
 * An area code's option text in the filter (#117): a code on UNNAMED_TARGETS
 * says EiBi doesn't name it, and a compass code says it's a beam heading, not
 * a place. Only the option says so; the status line uses the bare name.
 */
export function areaLabel({ code, name }: AreaCode): string {
  if (UNNAMED_TARGETS.has(code) && name === code) return `${code} (unnamed in EiBi)`;
  return COMPASS.includes(code) ? `${name} (beam heading)` : name;
}

/**
 * The specific target codes for the area filter: every code the broadcasts
 * use, named from `targetNames` where it has a name (the server leaves
 * unnamed ones out, so the codes come from the rows: eng outside voice O2),
 * sorted by name; then a saved code the schedule no longer uses, kept and
 * marked stale so it can be cleared (eng D8). Names go through displayName,
 * as an older server's names weren't tidied (#117).
 */
export function areaCodes(
  broadcasts: readonly { target: string }[],
  targetNames: Readonly<Record<string, string>>,
  saved?: string,
): AreaCode[] {
  const name = (code: string) => (Object.hasOwn(targetNames, code) ? displayName(targetNames[code]!) : code);
  const codes = new Set<string>();
  for (const { target } of broadcasts) if (target.trim()) codes.add(target.trim());
  const out = [...codes].map((code) => ({ code, name: name(code), stale: false }));
  out.sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  if (saved && !codes.has(saved)) out.push({ code: saved, name: name(saved), stale: true });
  return out;
}
