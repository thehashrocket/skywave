import { describe, expect, it } from "vitest";
import snapshot from "@/server/eibi-snapshot.json";
import { parseEibi } from "./eibi";
import {
  areaCodes,
  areaLabel,
  broadRegionAt,
  displayName,
  MIN_AREAS,
  MIN_COUNTRIES,
  parseTargets,
  regionsOf,
  type TargetTable,
  targetName,
  UNNAMED_TARGETS,
  unnamedTargets,
  UNREGIONED,
} from "./eibi-targets";

/**
 * EiBi's README around the given country and area lines (copied from the
 * 2026-11-22 file), with its contents lines, padded past the floors with
 * made-up entries ("Q00", "Zz0").
 */
function readme(countries: string[], areas: string[], pad = { countries: MIN_COUNTRIES, areas: MIN_AREAS }) {
  const fillCountries = Array.from(
    { length: pad.countries },
    (_, i) => `   Q${i.toString(36).padStart(2, "0").toUpperCase()}  Filler ${i}`,
  );
  const fillAreas = Array.from({ length: pad.areas }, (_, i) => `   Zz${i.toString(36)} - Filler area ${i}`);
  return [
    "   I)   Language codes.",
    "   II)  Country codes.", // the contents lines: not the sections
    "   III) Target-area codes.",
    "   IV)  Transmitter-site codes.",
    "",
    "   II) Country codes.",
    '   Countries are referred to by their ITU code (cf. itu.int "List of all geographical area designations")',
    "   Asterisks (*) denote non-official abbreviations",
    "",
    ...countries,
    ...fillCountries,
    "",
    "   III) Target-area codes.",
    ...areas,
    ...fillAreas,
    "",
    "   Alternatively, ITU country codes may be used if the target area is limited to",
    "   a certain country. This is often the case for domestic stations.",
    "",
    "   IV) Transmitter site codes.",
    "   AFS: Meyerton 26S35-28E08",
  ].join("\r\n");
}

const COUNTRIES = [
  "   B    Brasil",
  "   CG7  Guantanamo Bay",
  "   CHN  China (People's Republic)",
  "   E    Spain",
  "   J    Japan",
];
const AREAS = [
  "   Am  - America(s)",
  "   C.. - Central ..",
  "   CIS - Commonwealth of Independent States (Former Soviet Union)",
  "   Eu  - Europe (often including North Africa/Middle East)",
  "   FE  - Far East",
  "   W.. - West ..",
  "   Af  - Africa",
];

describe("EiBi target names", () => {
  // Value: protects=README country and area lines become the names a row shows: brackets and "(s)" dropped, digits in country codes kept, the contents lines skipped (III's is spelled like its section), the list ending at the first blank line; fails_when=the parser reads the contents line as the section, keeps EiBi's notes in the name, misses CG7-style codes or runs into the paragraph after the list; why_new=station search re-check D5; seam=none; no_claim=future README layouts (lines copied from the 2026-11-22 README)
  it("reads the README's country and target-area lists", () => {
    const t = parseTargets(readme(COUNTRIES, AREAS));
    expect(t.countries).toMatchObject({ B: "Brasil", CG7: "Guantanamo Bay", CHN: "China", E: "Spain", J: "Japan" });
    expect(t.areas).toMatchObject({
      Am: "America",
      CIS: "Commonwealth of Independent States",
      Eu: "Europe",
      FE: "Far East",
    });
    expect(t.prefixes).toEqual({ C: "Central", W: "West" });
    expect(Object.keys(t.areas)).not.toContain("Alternatively,");
  });

  // Value: protects=a code resolves to an area, a prefixed area or a country, a one-letter country code beats the prefix rule ("E" is Spain), and blank or unknown codes have no name; fails_when=prefix codes are left unnamed, "E" reads as a prefix, an unknown code gets a guess, or a code like "constructor" reads Object's built-in property; why_new=station search re-check D1/C4; own keys from the /ship r2 adversarial review; seam=none; no_claim=what EiBi means by codes it doesn't list
  it("names area, prefixed and country codes", () => {
    const t = parseTargets(readme(COUNTRIES, AREAS));
    const cases: [string, string | undefined][] = [
      ["Eu", "Europe"],
      ["CEu", "Central Europe"],
      ["WAf", "West Africa"],
      ["CHN", "China"],
      ["E", "Spain"],
      ["J", "Japan"],
      ["Xyz", undefined],
      ["NAf", undefined], // no "N.." rule in this README
      ["", undefined],
      ["  ", undefined],
      ["constructor", undefined], // Object's own keys are never names
      ["toString", undefined],
    ];
    for (const [code, name] of cases) expect([code, targetName(t, code)]).toEqual([code, name]);
  });

  // Value: protects=a moved, cut-off or broken README never replaces good names: no sections, too few names for a whole file, or under 80% of the bundled table all throw; fails_when=a short download is bundled and rows lose their target line; why_new=station search re-check D5 (as the sites' floors, #72 D11); seam=none; no_claim=the exact floor values
  it("refuses a README that isn't whole", () => {
    expect(() => parseTargets("not the README")).toThrow(/no country or target-area section/);
    expect(() => parseTargets(readme(COUNTRIES, AREAS, { countries: 10, areas: MIN_AREAS }))).toThrow(
      /under the floor/,
    );
    expect(() => parseTargets(readme(COUNTRIES, AREAS, { countries: MIN_COUNTRIES, areas: 3 }))).toThrow(
      /under the floor/,
    );
    const big = parseTargets(readme(COUNTRIES, AREAS, { countries: 400, areas: 60 }));
    expect(() => parseTargets(readme(COUNTRIES, AREAS), big)).toThrow(/under 80% of the bundled/);
  });

  // Value: protects=the snapshot PR lists codes with no name, once each and sorted, leaving out blanks and the known-unnamed "Tas"; fails_when=a new EiBi code slips in unseen, or every season's PR complains about Tas; why_new=station search re-check D3 and the owner's known-unnamed list; seam=none; no_claim=none beyond protects
  it("lists codes with no name", () => {
    const t: TargetTable = { areas: { Eu: "Europe" }, countries: {}, prefixes: { W: "West" } };
    expect(unnamedTargets(t, ["Eu", "WEu", "Zq", "", "Tas", "Zq", "Ab"])).toEqual(["Ab", "Zq"]);
  });

  // Value: protects=every target code in the bundled season has a name, or is on the known-unnamed list, so rows don't silently lose their "to …" line; fails_when=a snapshot brings a code the bundled README lists don't name (the snapshot PR body says which), or the bundled file has no target names; why_new=station search re-check D3 (CI half; the PR body is the other); seam=none; no_claim=the names being right, only present
  it("names every target code in the bundled snapshot", () => {
    const t = (snapshot as { targets?: TargetTable }).targets;
    expect(t).toBeDefined();
    const codes = parseEibi(snapshot.csv, snapshot.season).map((b) => b.target);
    expect(unnamedTargets(t!, codes)).toEqual([]);
    for (const code of UNNAMED_TARGETS) expect(targetName(t!, code)).toBeUndefined();
  });

  // Value: protects=each kind of target code files under the right broad regions: areas, prefixed areas (with NAm/CAm/SAm/NAf as exceptions), countries, codes spanning two regions (Am, RUS, NAO, Car, Cau), Glo under all, and compass, blank and unknown codes under none; fails_when=a spanning code loses a region, NAm reads as both Americas, a compass code gets a region, or a country is missed; why_new=#109 eng D4; the owner reviewed each listed call at build (spanning codes, Caucasus, Turkey, Egypt, Mexico, Pacific and Atlantic islands, unregioned codes); seam=none; no_claim=geography beyond these rows
  it.each([
    ["Eu", ["eu"]],
    ["WEu", ["eu"]],
    ["SAs", ["as"]],
    ["NAm", ["na"]],
    ["CAm", ["la"]],
    ["SAm", ["la"]],
    ["NAf", ["af", "me"]],
    ["Am", ["na", "la"]],
    ["NAO", ["na", "eu"]],
    ["Car", ["la", "na"]],
    ["Cau", ["eu", "as"]],
    ["RUS", ["eu", "as"]],
    ["CHN", ["as"]],
    ["B", ["la"]],
    ["USA", ["na"]],
    ["IRN", ["me"]],
    ["NZL", ["oc"]],
    ["Glo", ["na", "eu", "as", "af", "me", "oc", "la"]],
    // Owner-reviewed calls (#109 build, 2026-11-24): pinned so a change is deliberate.
    ["SAO", ["la", "af"]],
    ["WIO", ["af", "as"]],
    ["CIS", ["eu", "as"]],
    ["GEO", ["eu", "as"]],
    ["ARM", ["eu", "as"]],
    ["AZE", ["eu", "as"]],
    ["TUR", ["eu", "me"]],
    ["EGY", ["af", "me"]],
    ["MEX", ["la"]],
    ["HWA", ["na"]],
    ["BER", ["na"]],
    ["GRL", ["na"]],
    ["GUM", ["oc"]],
    ["MRA", ["oc"]],
    ["In", ["as"]],
    ["FE", ["as"]],
    ["AFG", ["as"]],
    ["PAK", ["as"]],
    ["SDN", ["af"]],
    ["LBY", ["af"]],
    ["CYP", ["eu"]],
    ["KAZ", ["as"]],
    ["CNR", ["eu"]],
    ["MDR", ["eu"]],
    ["AZR", ["eu"]],
    ["FLK", ["la"]],
    ["NE", []],
    ["ATA", []],
    ["IW", []],
    ["CLA", []],
    ["XUU", []],
    ["WNW", []],
    ["Tas", []],
    ["", []],
    ["constructor", []],
  ])("files %s under its regions", (code, regions) => {
    expect(regionsOf(code)).toEqual(regions);
  });

  // Value: protects=every target code in the bundled season is under at least one broad region or on the UNREGIONED list, and nothing on that list has one, so no row silently drops out of every region filter; fails_when=a snapshot brings a code with no region (the failure names it, for the snapshot PR) or a listed code gains one; why_new=#109 eng D4 (CI half, like the target names); seam=none; no_claim=the regions being right, only present; codes the live file adds between snapshots
  it("regions every target code in the bundled snapshot", () => {
    const codes = new Set(parseEibi(snapshot.csv, snapshot.season).map((b) => b.target.trim()));
    codes.delete("");
    expect([...codes].filter((c) => regionsOf(c).length === 0 && !UNREGIONED.has(c)).sort()).toEqual([]);
    for (const code of UNREGIONED) expect(regionsOf(code)).toEqual([]);
  });

  // Value: protects=a receiver's position gives the region the suggestion offers, with the Middle East ahead of Africa and Asia, Oceania across the 180th meridian, Hawaii and the US south in North America, North Africa's coast in Africa while southern Spain, Gibraltar, Malta and Pantelleria stay in Europe, Papua New Guinea and the Solomons in Oceania while Indonesian Papua stays in Asia, the Caucasus in Europe and Central Asia in Asia while north-east Iran stays Middle East, Cuba and the Bahamas in Latin America while Florida and northern Mexico stay North America, and nothing in mid-ocean; fails_when=box order or the 180° wrap breaks, Florida reads as Latin America, or a North African or New Guinea receiver gets Europe or Asia (build review item 4, owner chose to tighten); why_new=#109 eng D2; seam=none; no_claim=box edges between the sample points
  it.each([
    ["Boston", 42.4, -71.1, "na"],
    ["Miami", 25.8, -80.2, "na"],
    ["Honolulu", 21.3, -157.9, "na"],
    ["Mexico City", 19.4, -99.1, "la"],
    ["Havana", 23.13, -82.38, "la"],
    ["Nassau", 25.06, -77.35, "la"],
    ["Key West", 24.55, -81.78, "na"],
    ["Palm Beach", 26.7, -80.04, "na"],
    // Deliberate (owner, build review): northern Mexico stays North America.
    ["Monterrey", 25.67, -100.3, "na"],
    ["Tijuana", 32.5, -117.0, "na"],
    ["Twente", 52.2, 6.9, "eu"],
    ["Cairo", 30.0, 31.2, "af"],
    ["Tangier", 35.78, -5.81, "af"],
    ["Algiers", 36.75, 3.06, "af"],
    ["Tunis", 36.8, 10.18, "af"],
    ["Bizerte", 37.27, 9.87, "af"],
    ["Malaga", 36.72, -4.42, "eu"],
    ["Almeria", 36.83, -2.46, "eu"],
    ["Gibraltar", 36.14, -5.35, "eu"],
    ["Malta", 35.9, 14.51, "eu"],
    ["Pantelleria", 36.83, 11.94, "eu"],
    ["Port Moresby", -9.44, 147.18, "oc"],
    ["Honiara", -9.43, 159.95, "oc"],
    ["Jayapura", -2.53, 140.7, "as"],
    ["Tel Aviv", 32.1, 34.8, "me"],
    ["Tehran", 35.7, 51.4, "me"],
    ["Mashhad", 36.3, 59.6, "me"],
    ["Tbilisi", 41.7, 44.8, "eu"],
    ["Yerevan", 40.18, 44.51, "eu"],
    ["Baku", 40.4, 49.9, "eu"],
    ["Ashgabat", 37.95, 58.38, "as"],
    ["Tokyo", 35.7, 139.7, "as"],
    ["Sydney", -33.9, 151.2, "oc"],
    ["Fiji", -18.1, 178.4, "oc"],
    ["Samoa", -13.8, -171.8, "oc"],
    ["mid-Atlantic", 0, -30, undefined],
  ])("places a receiver in %s", (_place, lat, lon, region) => {
    expect(broadRegionAt(lat, lon)).toBe(region);
  });

  // Value: protects=the area filter's specific codes are every code the rows use, unnamed ones too (the server's names leave them out), sorted by name, with a saved code the schedule no longer uses kept at the end and marked stale; fails_when=unnamed codes vanish, the order breaks, or a stale saved code is dropped (eng D8); why_new=#109, eng outside voice O2, D8; seam=none; no_claim=none beyond protects
  it("lists the area codes the rows use", () => {
    const rows = [{ target: "WEu" }, { target: "Tas" }, { target: "" }, { target: "CHN" }, { target: "WEu" }];
    const names = { WEu: "West Europe", CHN: "China" };
    expect(areaCodes(rows, names)).toEqual([
      { code: "CHN", name: "China", stale: false },
      { code: "Tas", name: "Tas", stale: false },
      { code: "WEu", name: "West Europe", stale: false },
    ]);
    expect(areaCodes(rows, names, "SAs").at(-1)).toEqual({ code: "SAs", name: "SAs", stale: true });
    expect(areaCodes(rows, names, "CHN")).toHaveLength(3);
  });

  // Value: protects=rows and the area filter show tidy names for EiBi's raw ones: no trailing " *" footnote marker, no bracketed note the marker hid ("Ogasawara", as "Europe (often …)" is "Europe"), "Bangladesh" not "Bangla Desh", also for an older server's untidied names; only the filter's option text marks "Tas" as unnamed in EiBi and a compass code as a beam heading, and every code stays the same so filtering is unchanged; fails_when=a scraped-looking label is back in the select or a row's "to …" line, the option suffixes reach the bare name the status line uses, a label change alters a code, or an older server's unnamed codes all read "(unnamed in EiBi)"; why_new=#117 (design critique 2026-11-23) and the /ship review of PR #119; seam=none; no_claim=what EiBi means by "Tas"
  it("tidies EiBi's names for display without changing codes", () => {
    const table = snapshot.targets as TargetTable;
    expect(targetName(table, "TWN")).toBe("Taiwan");
    expect(targetName(table, "BGD")).toBe("Bangladesh");
    expect(targetName(table, "IWA")).toBe("Ogasawara");
    expect(targetName(table, "WNW")).toBe("West-northwest");
    expect(displayName("America(s)")).toBe("America");
    const rows = [{ target: "TWN" }, { target: "BGD" }, { target: "Tas" }, { target: "WNW" }, { target: "Xyz" }];
    // Names as an older server, before targetName tidied them, would send.
    const raw = { TWN: "Taiwan *", BGD: "Bangla Desh", WNW: "West-northwest" };
    const codes = areaCodes(rows, raw);
    expect(codes).toEqual([
      { code: "BGD", name: "Bangladesh", stale: false },
      { code: "TWN", name: "Taiwan", stale: false },
      { code: "Tas", name: "Tas", stale: false },
      { code: "WNW", name: "West-northwest", stale: false },
      { code: "Xyz", name: "Xyz", stale: false },
    ]);
    expect(codes.map(areaLabel)).toEqual([
      "Bangladesh",
      "Taiwan",
      "Tas (unnamed in EiBi)",
      "West-northwest (beam heading)",
      "Xyz",
    ]);
    // A saved code the schedule dropped keeps its tidied name.
    expect(areaCodes([], raw, "TWN")).toEqual([{ code: "TWN", name: "Taiwan", stale: true }]);
  });
});
