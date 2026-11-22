import { describe, expect, it } from "vitest";
import snapshot from "@/server/eibi-snapshot.json";
import { parseEibi } from "./eibi";
import {
  MIN_AREAS,
  MIN_COUNTRIES,
  parseTargets,
  type TargetTable,
  targetName,
  UNNAMED_TARGETS,
  unnamedTargets,
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

  // Value: protects=a code resolves to an area, a prefixed area or a country, a one-letter country code beats the prefix rule ("E" is Spain), and blank or unknown codes have no name; fails_when=prefix codes are left unnamed, "E" reads as a prefix, or an unknown code gets a guess; why_new=station search re-check D1/C4; seam=none; no_claim=what EiBi means by codes it doesn't list
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
});
