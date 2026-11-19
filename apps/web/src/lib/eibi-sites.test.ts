import { describe, expect, it } from "vitest";
import snapshot from "@/server/eibi-snapshot.json";
import { candidateFor, MIN_SHARE, MIN_SITES, parseSites, siteKey, sitesFromJson, sitesToJson } from "./eibi-sites";

/** EiBi's README around the given site lines, padded past MIN_SITES with made-up sites in country "ZZZ". */
function readme(lines: string[], filler = MIN_SITES) {
  const pad = Array.from(
    { length: filler },
    (_, i) => `        ${i.toString(36).padStart(3, "0")}-Filler ${i} 10N00-010E00`,
  );
  return [
    "   IV)  Transmitter-site codes.", // the contents line: not the section
    "",
    "   IV) Transmitter site codes.",
    "   One-letter or two-letter codes for different transmitter sites within one country.",
    "    For Brazil: http://sistemas.anatel.gov.br/",
    "",
    ...lines,
    "   ZZZ: Default 01N00-001E00 except:",
    ...pad,
    "",
  ].join("\r\n");
}

describe("EiBi transmitter sites", () => {
  // Value: protects=README site lines become the right keys and degrees, including seconds, southern/western signs, the file's slips (missing dash, stray space), default sites on the country line, wrapped lines, codes without coordinates, groups, case (CHN b vs B), and impossible numbers (latitude past 90, minutes past 59) placing nothing; fails_when=a quirk line is skipped or mis-signed, two sites merge, or a misprint puts a site at a bogus point; why_new=#72 site parser; seam=none; no_claim=future README layouts (lines copied from the 2026-11-19 README)
  it("reads the site lines as EiBi writes them", () => {
    const sites = parseSites(
      readme([
        "   AFS: Meyerton 26S35-28E08 except:",
        `        j-Johannesburg 26S07'40"-28E12'20"`,
        `   AUS: ct-VKS737 Charter Towers QLD 20S05'06"146E15'34"`,
        `        mi-RFDS Mount Isa QLD 20S 43'31"-139E29'14"`,
        "        xx-Unknown Location",
        "        zz-Misprinted 95N00-010E00 and 10N75-010E00",
        `   CHN: b-Beijing-Matoucun "572" (100 kW CNR1) 39N45-116E49`,
        `        B-Beijing-Chaoyang/Gaobeidian/Shuangqiao "491" (CNR2-8) 39N53-116E34`,
        "   E:   to-Torrejón de Ardoz (Pegaso, Pavon, Brujo) 40N30-03W27",
        "           Jota,Polar-Zaragoza; Perseo-Alcala de los Gazules",
        "   USA: ob-San Luis Obispo, CA, 3 tx sites: San Luis Obispo 35N13-120W52, Ragged Point 35N47-121W20, Vandenberg 34N35-120W39",
      ]),
    );
    expect(sites.get("AFS")).toEqual({ country: "AFS", coords: [[-26.5833, 28.1333]] });
    expect(sites.get("AFS-j")!.coords).toEqual([[-26.1278, 28.2056]]);
    expect(sites.get("AUS-ct")!.coords).toEqual([[-20.085, 146.2594]]);
    expect(sites.get("AUS-mi")!.coords).toEqual([[-20.7253, 139.4872]]);
    expect(sites.get("AUS-xx")).toEqual({ country: "AUS", coords: [] });
    // Impossible numbers (latitude past 90, minutes past 59) place nothing rather than a bogus point.
    expect(sites.get("AUS-zz")).toEqual({ country: "AUS", coords: [] });
    expect(sites.get("CHN-b")!.coords).toEqual([[39.75, 116.8167]]);
    expect(sites.get("CHN-B")!.coords).toEqual([[39.8833, 116.5667]]);
    expect(sites.get("E-to")!.coords).toEqual([[40.5, -3.45]]);
    expect(sites.get("USA-ob")!.coords).toEqual([
      [35.2167, -120.8667],
      [35.7833, -121.3333],
      [34.5833, -120.65],
    ]);
  });

  // Value: protects=with no earlier table, a file without the site section or under the MIN_SITES floor throws (giving its count and the floor), so an error page never becomes the first table; fails_when=an error page or truncated first download is taken as the table; why_new=#72 D11; seam=none; no_claim=a broken file that still lists 1,000+ sites
  it("holds a first table to the floor", () => {
    expect(() => parseSites("<html>moved</html>")).toThrow(/no transmitter site section/);
    expect(() => parseSites(readme([], 300))).toThrow(/301 transmitter sites, under the first-parse floor of 1000/);
    expect(parseSites(readme([])).size).toBe(MIN_SITES + 1);
  });

  // Value: protects=against the last good table, a README cut off mid-table (under MIN_SHARE of its sites) is refused with both counts, while one with a few sites added or removed is taken; fails_when=a truncated download replaces the table, or EiBi's ordinary edits are refused; why_new=owner rule before /ship (#72); seam=none; no_claim=a cut that keeps 80%+ of the sites
  it("refuses a table cut short against the last good one", () => {
    const last = parseSites(readme([], 1_500));
    const lines = readme([], 1_500).split("\r\n");
    const cut = lines.slice(0, Math.floor(lines.length * 0.6)).join("\r\n");
    expect(() => parseSites(cut, last)).toThrow(
      new RegExp(`\\d+ transmitter sites, under ${MIN_SHARE * 100}% of the last good table's ${last.size}`),
    );
    expect(parseSites(readme([], 1_480), last).size).toBe(1_481);
    expect(parseSites(readme([], 1_520), last).size).toBe(1_521);
    // A smaller table than the floor is fine once there's a last good one to compare with.
    const small = new Map(Array.from({ length: 450 }, (_, i) => [`ZZZ-${i}`, { country: "ZZZ", coords: [] }]));
    expect(parseSites(readme([], 400), small).size).toBe(401);
  });

  // Value: protects=the bundled table is a parsed README: past MIN_SITES, case kept (CHN b and B differ), and stored in the exact form sitesToJson writes; fails_when=the snapshot is written by a broken parser, merges case, or loses its sites; why_new=#72 D2 (bundled fallback); seam=reads eibi-snapshot.json; no_claim=that the bundled table is current, or any one site's coordinates (they change with EiBi)
  it("bundles a real site table", () => {
    const sites = sitesFromJson(snapshot.sites);
    expect(sites.size).toBeGreaterThanOrEqual(MIN_SITES);
    expect(sites.get("CHN-b")).not.toEqual(sites.get("CHN-B"));
    expect(sitesToJson(sites)).toEqual(snapshot.sites);
  });

  // Value: protects=a schedule row's Remarks become the README's keys: a plain code in the station's country, "/ABC" and "/ABC-x" in the host country, blank as the country itself, and anything else as no key; fails_when=a relay site is looked up in the station's country or a remark is misread as a code; why_new=#72 site keys; seam=none; no_claim=none beyond protects
  it("keys a schedule row's site", () => {
    expect(siteKey("RUS", "s")).toBe("RUS-s");
    expect(siteKey("G", "/RUS-s")).toBe("RUS-s");
    expect(siteKey("TWN", "/UZB")).toBe("UZB");
    expect(siteKey("TWN", " ")).toBe("TWN");
    expect(siteKey("CHN", "B")).toBe("CHN-B");
    expect(siteKey("USA", "[0923]")).toBeUndefined();
  });

  // Value: protects=a lookup separates a placed site, a code the table lacks (key, no coordinates) and EiBi not saying which site (key null with the country: the relay host's for "/ABC", not the station's); fails_when=unknown sites look like lookup failures, a missing code is dropped, or a relay is filed under the station's country; why_new=#72 D12; seam=none; no_claim=none beyond protects
  it("looks up a key", () => {
    const sites = sitesFromJson({
      AFS: { country: "AFS", coords: [[-26.6, 28.1]] },
      "RUS-s": { country: "RUS", coords: [[53.3, 50.3]] },
    });
    expect(candidateFor(sites, "RUS-s", "G")).toEqual({ key: "RUS-s", coords: [[53.3, 50.3]] });
    expect(candidateFor(sites, "AFS", "AFS")).toEqual({ key: "AFS", coords: [[-26.6, 28.1]] });
    expect(candidateFor(sites, "RUS-q", "RUS")).toEqual({ key: "RUS-q", coords: [] });
    expect(candidateFor(sites, "TWN", "TWN")).toEqual({ key: null, country: "TWN", coords: [] });
    // A relay ("/UZB" on a Taiwanese station) with no default site names the host country, not the station's.
    expect(candidateFor(sites, "UZB", "TWN")).toEqual({ key: null, country: "UZB", coords: [] });
    expect(candidateFor(sites, undefined, "USA")).toEqual({ key: null, country: "USA", coords: [] });
  });
});
