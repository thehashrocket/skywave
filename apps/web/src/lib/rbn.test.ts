import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unzipFile } from "@/server/unzip";
import { BEACONS } from "./ibp";
import {
  countBeaconSpots,
  dayBefore,
  maidenhead,
  parseSkimmerList,
  quietBeacons,
  RBN_DAY_URL,
  RBN_MIN_DAY_SPOTS,
  RBN_MIN_SKIMMERS,
  rbnDayFor,
  type RbnDay,
} from "./rbn";

// A sample of RBN's real file for 2026-11-18: ordinary and BEACON-mode spots,
// every 40th NCDXF B spot, and each beacon's last one (VR2B and YV5B had none).
const zip = readFileSync(new URL("./fixtures/rbn-20261118-sample.zip", import.meta.url));
const CSV = unzipFile(zip, ".csv", 1_000_000).toString("utf8");
const HEADER = "callsign,de_pfx,de_cont,freq,band,dx,dx_pfx,dx_cont,mode,db,date,speed,tx_mode";
const spot = (dx: string, freq = "14100", mode = "NCDXF B", date = "2026-11-18 12:00:00") =>
  `K1RA-4,K,NA,${freq},20m,${dx},X,NA,${mode},9,${date},22,CW`;

describe("countBeaconSpots", () => {
  // Value: protects=a real RBN file reads as RBN means it: only NCDXF B spots of the 18 beacons count (BEACON-mode and ordinary spots don't), every beacon is listed in transmission order, and the two beacons with no spots that day (VR2B and YV5B, both really off) count zero; fails_when=other modes or callsigns are counted, a beacon goes missing from the list, or the count is off; why_new=issue #69 v2; seam=a sample of RBN's file for 2026-11-18; no_claim=other days' files
  it("counts each beacon's spots in RBN's file", () => {
    const day = countBeaconSpots(CSV, "2026-11-18");
    expect(day.beacons.map((b) => b.call)).toEqual(BEACONS.map((b) => b.call));
    const count = Object.fromEntries(day.beacons.map((b) => [b.call, b.spots]));
    expect(count).toMatchObject({ VR2B: 0, YV5B: 0, "4U1UN": 103, CS3B: 130, JA2IGY: 3 });
    expect(day.total).toBe(CSV.split("\n").filter((l) => l.includes(",NCDXF B,")).length);
    expect(day.beacons.filter((b) => b.spots === 0).map((b) => b.call)).toEqual(["VR2B", "YV5B"]);
  });

  // Value: protects=damaged or odd lines are skipped rather than miscounted: other modes (including one that only contains "NCDXF B"), unknown callsigns, spots more than half a kHz off a beacon frequency (but 0.1 kHz off counts), another day's spots, short and junk lines, CRLF and lowercase callsigns; fails_when=any of those counts, or a near-frequency spot is dropped; why_new=issue #69 v2 (defensive parsing); seam=none; no_claim=none beyond protects
  it("skips what isn't a beacon spot that day", () => {
    const csv = [
      HEADER,
      spot("4U1UN"),
      spot("4u1un", "18110.1"),
      spot("4U1UN", "18109.9"),
      spot("4U1UN", "14101"),
      spot("4U1UN", "14100", "BEACON"),
      spot("4U1UN", "14100", "NCDXF BEACON"),
      spot("4U1UN", "14100", "NCDXF B", "2026-11-17 23:59:59"),
      spot("N0CALL"),
      "garbage",
      "K1RA-4,K,NA,14100,20m",
      "",
    ].join("\r\n");
    const day = countBeaconSpots(csv, "2026-11-18");
    expect(day.total).toBe(3);
    expect(day.beacons.find((b) => b.call === "4U1UN")!.spots).toBe(3);
  });

  // Value: protects=a file that isn't RBN's (an error page, a changed header) is refused, so the server keeps what it has instead of storing a day of zeros that would mark every beacon quiet; fails_when=an unreadable file parses to all zeros; why_new=issue #69 v2; seam=none; no_claim=none beyond protects
  it.each([
    ["an error page", "error code: 502"],
    ["an empty file", ""],
    ["a changed header", "who,when,where\nx,y,z"],
  ])("refuses %s", (_, csv) => {
    expect(() => countBeaconSpots(csv, "2026-11-18")).toThrow(/Not RBN's spot file/);
  });
});

describe("quietBeacons", () => {
  const day = (spots: Record<string, number>, total: number): RbnDay => ({
    day: "2026-11-18",
    total,
    beacons: BEACONS.map((b) => ({ call: b.call, spots: spots[b.call] ?? 100 })),
  });

  // Value: protects=a beacon counts as quiet only with no spot all day, and nothing is marked on a day RBN itself barely heard beacons (its own outage) or with no day; fails_when=a beacon with any spot is marked, or an RBN outage marks every beacon quiet; why_new=issue #69 v2 (owner: zero spots all day only); seam=none; no_claim=none beyond protects
  it("marks only beacons with no spot all day, on a day RBN was working", () => {
    expect([...quietBeacons(day({ VR2B: 0, YV5B: 0, OH2B: 1 }, RBN_MIN_DAY_SPOTS))]).toEqual(["VR2B", "YV5B"]);
    expect(quietBeacons(day({ VR2B: 0 }, RBN_MIN_DAY_SPOTS - 1)).size).toBe(0);
    expect(quietBeacons(null).size).toBe(0);
  });
});

describe("days", () => {
  // Value: protects=the day asked for is yesterday from 01:00 UTC (RBN posts just after midnight) and the day before until then, and the URL is RBN's; fails_when=today's unfinished day is asked for, or the hour's wait is dropped; why_new=issue #69 v2; seam=none; no_claim=when RBN actually posts
  it("asks for yesterday once its file should be up", () => {
    expect(rbnDayFor(Date.parse("2026-11-19T00:59:59Z"))).toBe("2026-11-17");
    expect(rbnDayFor(Date.parse("2026-11-19T01:00:00Z"))).toBe("2026-11-18");
    expect(rbnDayFor(Date.parse("2026-11-19T23:59:59Z"))).toBe("2026-11-18");
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
    expect(RBN_DAY_URL("2026-11-18")).toBe("https://data.reversebeacon.net/rbn_history/20261118.zip");
  });
});

// Four rows of RBN's real skimmer list, 2026-11-19 (status.php?t=skt), plus
// rows made in the same shape to reach the floor.
const SKIMMERS = readFileSync(new URL("./fixtures/rbn-skimmers-20261119-sample.html", import.meta.url), "utf8");
const skimmerRow = (call: string, grid: string, seconds: number, bands = "20m") =>
  `<tr class="online"><td><a href="/dxsd1.php?f=0&c=${call}&t=de">${call}</a></td><td class="right">${bands}</td>` +
  `<td>${grid}</td><td><a href="/dxsd1.php?t=x&id_dxcc_de=1&de=dxcc">ZZ</a></td>` +
  `<td><a href="/dxsd1.php?t=x&id_cont_de=EU&de=dxcc">EU</a></td><td><a href="/dxsd1.php?t=x&id_itu_z_de=1">1</a></td>` +
  `<td><a href="/dxsd1.php?t=x&id_cq_z_de=1">1</a></td><td><b class="hide">0001000000</b> 11 days ago</td>` +
  `<td><b class="hide">${String(seconds).padStart(10, "0")}</b> online</td></tr>`;
const filler = (n: number, grid = "JO22AB") =>
  Array.from({ length: n }, (_, i) => skimmerRow(`F${i.toString(36).toUpperCase()}1X`, grid, 60)).join("\n");
const FETCHED = Date.parse("2026-11-19T01:30:00Z");

describe("RBN skimmer list", () => {
  // Value: protects=each skimmer's callsign, bands, grid (upper-cased) and last-seen time come out of RBN's real rows, with last seen as fetch time minus the page's seconds-ago; fails_when=a cell shifts, a grid keeps RBN's lower case, the seconds are added or kept relative, or a slash/dash callsign or empty band list is dropped; why_new=#61 D14 skimmer snapshots; seam=none; no_claim=whether operators typed the right grid
  it("reads RBN's rows", () => {
    const skimmers = parseSkimmerList(SKIMMERS + filler(RBN_MIN_SKIMMERS), FETCHED);
    expect(skimmers.slice(0, 4)).toEqual([
      { call: "HA5E", grid: "JN86QQ", bands: ["40m", "80m"], lastSeen: FETCHED - 2_000 },
      { call: "VE2SUS", grid: "FN35DL", bands: ["40m"], lastSeen: FETCHED - 4_000 },
      { call: "ON6URE-2", grid: "JO11JD", bands: ["40m", "80m"], lastSeen: FETCHED - 5_000 },
      { call: "DK8NE/0", grid: "JO50AL", bands: [], lastSeen: FETCHED - 7_000 },
    ]);
    expect(skimmers).toHaveLength(4 + RBN_MIN_SKIMMERS);
  });

  // Value: protects=an operator-typed grid that isn't a 4-, 6- or 8-character Maidenhead locator is kept as null (the callsign still listed), an 8-character one is kept to its 6-character square, and a callsign listed twice keeps its most recent row; fails_when=a bad grid is saved as a location, a valid extended locator is lost, drops the skimmer, or a stale duplicate wins; why_new=#61 D14 plan Section 1 #4, /ship Step 11 (owner D6); seam=none; no_claim=a valid but wrong grid
  it("keeps only real locators, and the latest row per callsign", () => {
    expect(["FN35dl", " jn86 ", "JN86qq42", "XX99", "JN8", "JN86QQ1", "JN86QQ4", ""].map(maidenhead)).toEqual([
      "FN35DL",
      "JN86",
      "JN86QQ",
      null,
      null,
      null,
      null,
      null,
    ]);
    const skimmers = parseSkimmerList(
      [skimmerRow("W1BAD", "nowhere", 10), skimmerRow("K1DUP", "FN42AA", 500), skimmerRow("K1DUP", "FN42BB", 20), filler(RBN_MIN_SKIMMERS)].join("\n"),
      FETCHED,
    );
    expect(skimmers.find((s) => s.call === "W1BAD")).toEqual({ call: "W1BAD", grid: null, bands: ["20m"], lastSeen: FETCHED - 10_000 });
    expect(skimmers.filter((s) => s.call === "K1DUP")).toEqual([
      { call: "K1DUP", grid: "FN42BB", bands: ["20m"], lastSeen: FETCHED - 20_000 },
    ]);
  });

  // Value: protects=a page that isn't RBN's list (error page, a row missing a cell, columns moved, a row whose callsign or last-seen seconds can't be read, too few skimmers with a usable grid) throws instead of becoming a day's list, including a reordered table whose rows still have 9 cells; fails_when=a partial or reshuffled page is saved, freezing that day with wrong or empty locations, or a blank callsign or NaN last-seen is saved; why_new=#61 D14, outside voice OV3; the callsign/last-seen rows were added by the /ship coverage audit; seam=none; no_claim=a layout change that keeps every column's link and meaning but changes the grid's format
  it("refuses a page that isn't the whole list", () => {
    expect(() => parseSkimmerList("<html>Service unavailable</html>", FETCHED)).toThrow(/0 skimmers with a usable grid/);
    const short = filler(RBN_MIN_SKIMMERS).replace("<td>JO22AB</td>", "");
    expect(() => parseSkimmerList(short, FETCHED)).toThrow(/expected columns/);
    // The two time columns swapped: last seen would read older than first seen.
    const swapped = filler(RBN_MIN_SKIMMERS).replace("0001000000</b> 11 days ago", "0000000001</b> 1 s ago");
    expect(() => parseSkimmerList(swapped, FETCHED)).toThrow(/older than its first-seen/);
    // Cut off partway through the last row.
    const cut = filler(RBN_MIN_SKIMMERS + 1);
    expect(() => parseSkimmerList(cut.slice(0, cut.lastIndexOf("</td>")), FETCHED)).toThrow(/partway through a row/);
    const moved = filler(RBN_MIN_SKIMMERS).replace("id_cont_de=", "id_itu_z_de=");
    expect(() => parseSkimmerList(moved, FETCHED)).toThrow(/expected columns/);
    const noLastSeen = filler(RBN_MIN_SKIMMERS).replace('<b class="hide">0000000060</b> online', "online");
    expect(() => parseSkimmerList(noLastSeen, FETCHED)).toThrow(/callsign or last-seen time can't be read/);
    const noCall = [skimmerRow("", "JO22AB", 60), filler(RBN_MIN_SKIMMERS)].join("\n");
    expect(() => parseSkimmerList(noCall, FETCHED)).toThrow(/callsign or last-seen time can't be read/);
    expect(() => parseSkimmerList(filler(RBN_MIN_SKIMMERS, "nowhere"), FETCHED)).toThrow(
      new RegExp(`0 skimmers with a usable grid, under ${RBN_MIN_SKIMMERS}`),
    );
    expect(parseSkimmerList(filler(RBN_MIN_SKIMMERS), FETCHED)).toHaveLength(RBN_MIN_SKIMMERS);
    // Cut at a row boundary, then an error message: RBN's page ends right after its last row.
    const trailing = `${filler(RBN_MIN_SKIMMERS)}\n<br /><b>Fatal error</b>: Maximum execution time exceeded`;
    expect(() => parseSkimmerList(trailing, FETCHED)).toThrow(/something follows the last row/);
    expect(parseSkimmerList(`${filler(RBN_MIN_SKIMMERS)}\n    \n`, FETCHED)).toHaveLength(RBN_MIN_SKIMMERS);
  });

  // Value: protects=a band RBN writes in kHz (630 m as "472kHz") is kept beside metre bands, and HTML entities in a callsign, grid or band cell are decoded before checking; fails_when=a 630 m skimmer loses that band, or an entity-encoded callsign refuses the whole page or a grid like "FN35&#68;L" is saved as null; why_new=skimmer-snapshot /ship review note (5), live page 2026-11-21 lists one "472kHz" skimmer; seam=none; no_claim=entities RBN never sends today (none on the live page)
  it("keeps kHz bands and decodes HTML entities", () => {
    const rows = [
      skimmerRow("K1&#47;W", "fn35&#68;l", 10, "472kHz, 2m,&nbsp;70cm, 5MHz"),
      skimmerRow("N0&amp;X", "EM48", 20),
      filler(RBN_MIN_SKIMMERS),
    ].join("\n");
    expect(() => parseSkimmerList(rows, FETCHED)).toThrow(/callsign or last-seen time can't be read/); // "N0&X" isn't a callsign
    const skimmers = parseSkimmerList([rows.split("\n")[0], filler(RBN_MIN_SKIMMERS)].join("\n"), FETCHED);
    expect(skimmers[0]).toEqual({ call: "K1/W", grid: "FN35DL", bands: ["472kHz", "2m", "70cm"], lastSeen: FETCHED - 10_000 });
    // Value: protects=hex character references (&#x2F;, &#X41;) decode like decimal ones; fails_when=the hex branch is dropped or parsed in base 10, so a hex-encoded callsign refuses the page or its grid saves as null; why_new=the rows above use decimal and named entities only; seam=none; no_claim=entities RBN never sends today
    const hex = parseSkimmerList([skimmerRow("K2&#x2F;P", "em48&#X41;a", 30), filler(RBN_MIN_SKIMMERS)].join("\n"), FETCHED);
    expect(hex[0]).toMatchObject({ call: "K2/P", grid: "EM48AA" });
    // Value: protects=a reference past Unicode's last code point is left as written, costing only that cell, not the day's page; fails_when=String.fromCodePoint's RangeError refuses the whole list with an unrelated error; why_new=Step 9 specialist finding; seam=none; no_claim=RBN ever sending one
    const wide = parseSkimmerList([skimmerRow("K3X", "FN35&#99999999;", 10), filler(RBN_MIN_SKIMMERS)].join("\n"), FETCHED);
    expect(wide[0]).toMatchObject({ call: "K3X", grid: null });
  });
});
