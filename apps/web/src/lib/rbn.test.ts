import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unzipFile } from "@/server/unzip";
import { BEACONS } from "./ibp";
import { countBeaconSpots, dayBefore, quietBeacons, RBN_DAY_URL, RBN_MIN_DAY_SPOTS, rbnDayFor, type RbnDay } from "./rbn";

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
