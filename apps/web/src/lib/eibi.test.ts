import { describe, expect, it } from "vitest";
import snapshot from "@/server/eibi-snapshot.json";
import {
  type Broadcast,
  languageNames,
  onAirAt,
  onDay,
  parseEibi,
  scheduledBetween,
  scheduledOn,
  seasonFor,
  shortLabel,
  stationLine,
} from "./eibi";

const HEADER = "kHz:75;Time(UTC):93;Days:59;ITU:49;Station:201;Lng:49;Target:62;Remarks:135;P:35;Start:60;Stop:60;";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\r\n");
const at = (iso: string) => Date.parse(iso);
const day = (iso: string) => new Date(iso);
const b = (over: Partial<Broadcast>): Broadcast => ({
  khz: 9_580,
  start: 0,
  end: 1440,
  days: "",
  station: "Radio X",
  lang: "E",
  target: "Eu",
  ...over,
});

describe("EiBi schedule", () => {
  // Value: protects=the season names EiBi publishes under switch on the last Sundays of March and October, and January to March belongs to the winter that began the year before; fails_when=the server fetches a file that doesn't exist (wrong letter or year) around a switch; why_new=station names; seam=none; no_claim=EiBi publishing on time
  it("names the season by EiBi's dates", () => {
    expect(seasonFor(at("2026-11-10T00:00:00Z"))).toBe("b26");
    expect(seasonFor(at("2027-02-01T00:00:00Z"))).toBe("b26");
    expect(seasonFor(at("2027-03-27T23:59:00Z"))).toBe("b26");
    expect(seasonFor(at("2027-03-28T00:00:00Z"))).toBe("a27");
    expect(seasonFor(at("2026-10-24T23:59:00Z"))).toBe("a26");
    expect(seasonFor(at("2026-10-25T00:00:00Z"))).toBe("b26");
  });

  // Value: protects=parsing keeps live broadcasts sorted by frequency and drops inactive (P 8), other-season (P 4/5), alternative and spurious entries, and keeps only real date limits (P 6 both, others an end, with or without a "[last heard]" note after it, never the note alone); fails_when=a dead or summer-only entry names a station, or a last-heard note hides a live one; why_new=station names; seam=none; no_claim=EiBi's own accuracy
  it("keeps what's live this season", () => {
    const parsed = parseEibi(
      csv(
        "9580;1200-1300;;KOR;KBS World Radio;E;FE;k;4;;",
        "6070;0900-1300;;KRE;Voice of Korea;J;J;k;1;;[1026]",
        "6070;0700-1400;;D;SM Radio Dessau;D;Eu;r;6;2810;3012",
        "6070;0700-1400;;D;Ended;D;Eu;r;1;0103;3110",
        "2514;2235-2315;;CAN;VFF Iqaluit Radio;E;ENA;k;1;0107;2012[1121]",
        "7000;0000-2400;;X;Inactive;E;Eu;;8;;",
        "7000;0000-2400;;X;Summer only;E;Eu;;5;;",
        "7000;0000-2400;alt;X;Alternative;E;Eu;;1;;",
        "7000;0000-2400;spur;X;Spurious;E;Eu;;1;;",
        "not;a;row",
      ),
      "b26",
    );
    expect(parsed.map((p) => p.station)).toEqual([
      "VFF Iqaluit Radio",
      "Voice of Korea",
      "SM Radio Dessau",
      "Ended",
      "KBS World Radio",
    ]);
    // An end date with a last-heard note after it still ends the entry.
    expect(parsed[0]).toMatchObject({ to: "2012" });
    expect(parsed[1]).toEqual({
      khz: 6_070,
      start: 540,
      end: 780,
      days: "",
      station: "Voice of Korea",
      lang: "J",
      target: "J",
    });
    expect(parsed[2]).toMatchObject({ from: "2810", to: "3012" });
    expect(parsed[3]).toMatchObject({ to: "3110" });
    expect(parsed[3]!.from).toBeUndefined();
    expect(parseEibi(csv("7000;0000-2400;;X;Summer only;E;Eu;;5;;"), "a26")).toHaveLength(1);
  });

  // Value: protects=a page that isn't the schedule (moved file, error page, empty) throws instead of parsing to nothing, so the server keeps its good copy; fails_when=an HTML error page replaces the schedule and every name vanishes; why_new=station names; seam=none; no_claim=none
  it("throws on anything but the schedule", () => {
    expect(() => parseEibi("<html>moved</html>", "b26")).toThrow(/header/);
    expect(() => parseEibi(HEADER, "b26")).toThrow(/no broadcasts/);
  });

  // Value: protects=the bundled copy parses to a full season, so the fallback names stations; fails_when=a bad snapshot ships and the server's fallback throws or is empty; why_new=owner decision: a bundled snapshot fallback; seam=the committed snapshot file; no_claim=the snapshot is the current season
  it("parses the bundled copy", () => {
    expect(parseEibi(snapshot.csv, snapshot.season).length).toBeGreaterThan(5_000);
  });

  // Value: protects=every days form EiBi uses is read: daily, names, ranges that wrap, runs, digits, nth and last weekdays, single dates, and unknown forms count as on; fails_when=a weekday-only station is named every day, or a daily one never; why_new=station names; seam=none; no_claim=Ramadan or holiday schedules
  it("reads the days field", () => {
    const tue = day("2026-11-10T12:00:00Z");
    const wed = day("2026-11-11T12:00:00Z");
    const sat = day("2026-11-07T12:00:00Z");
    const sun = day("2026-11-08T12:00:00Z");
    expect(onDay("", wed)).toBe(true);
    expect(onDay("Tu,Th", tue)).toBe(true);
    expect(onDay("Tu,Th", wed)).toBe(false);
    expect(onDay("Mo-Fr", sat)).toBe(false);
    expect(onDay("Fr-Mo", sun)).toBe(true);
    expect(onDay("Fr-Mo", wed)).toBe(false);
    expect(onDay("SaSu", sat)).toBe(true);
    expect(onDay("SaSu", tue)).toBe(false);
    expect(onDay("1245", tue)).toBe(true);
    expect(onDay("1245", wed)).toBe(false);
    expect(onDay("1.Sa", sat)).toBe(true);
    expect(onDay("2.Sa", sat)).toBe(false);
    expect(onDay("Last7", day("2026-11-29T12:00:00Z"))).toBe(true);
    expect(onDay("Last7", sun)).toBe(false);
    expect(onDay("10Nov", tue)).toBe(true);
    expect(onDay("3Nov", tue)).toBe(false);
    expect(onDay("irr", tue)).toBe(true);
  });

  // Value: protects=a broadcast is on inside its hours and on its days, one over midnight counts from the day it began, and date limits (both ends, wrapping New Year, or an end alone) are kept; fails_when=a station shows outside its hours, the after-midnight part checks the wrong day, or an ended entry keeps showing; why_new=station names; seam=none; no_claim=none
  it("knows when a broadcast is on", () => {
    const evening = b({ start: 1170, end: 1230 }); // 1930-2030
    expect(onAirAt(evening, at("2026-11-10T19:30:00Z"))).toBe(true);
    expect(onAirAt(evening, at("2026-11-10T20:30:00Z"))).toBe(false);
    // 2330-0450 on Mondays: Tuesday 02:00 is Monday's broadcast, Monday 02:00 isn't.
    const overnight = b({ start: 1410, end: 290, days: "Mo" });
    expect(onAirAt(overnight, at("2026-11-10T02:00:00Z"))).toBe(true);
    expect(onAirAt(overnight, at("2026-11-09T02:00:00Z"))).toBe(false);
    expect(onAirAt(overnight, at("2026-11-09T23:45:00Z"))).toBe(true);
    const winterOnly = b({ from: "2810", to: "3012" });
    expect(onAirAt(winterOnly, at("2026-11-10T12:00:00Z"))).toBe(true);
    expect(onAirAt(winterOnly, at("2027-01-05T12:00:00Z"))).toBe(false);
    const overNewYear = b({ from: "1512", to: "1001" });
    expect(onAirAt(overNewYear, at("2027-01-05T12:00:00Z"))).toBe(true);
    expect(onAirAt(overNewYear, at("2026-11-10T12:00:00Z"))).toBe(false);
    expect(onAirAt(b({ to: "3110" }), at("2026-11-10T12:00:00Z"))).toBe(false);
    expect(onAirAt(b({ to: "3110" }), at("2026-10-20T12:00:00Z"))).toBe(true);
    expect(onAirAt(b({ to: "3004" }), at("2026-11-10T12:00:00Z"))).toBe(true);
  });

  // Value: protects=lookups find what's on within half a kHz, nearest first, one per station and language however many transmitter sites, and a range groups by frequency; fails_when=a neighbour 1 kHz off is named, the same station repeats, or a range misses its ends; why_new=station names; seam=none; no_claim=none
  it("finds what's on a frequency and in a range", () => {
    const schedule = [
      b({ khz: 9_579, station: "Neighbour" }),
      b({ khz: 9_580, station: "KBS World Radio" }),
      b({ khz: 9_580, station: "KBS World Radio" }),
      b({ khz: 9_580, station: "KBS World Radio", lang: "K" }),
      b({ khz: 9_580.4, station: "Off grid" }),
      b({ khz: 9_580, station: "Not now", start: 0, end: 60 }),
      b({ khz: 9_590, station: "Next" }),
    ];
    const noon = at("2026-11-10T12:00:00Z");
    expect(scheduledOn(schedule, 9_580.3, noon).map((x) => x.station)).toEqual([
      "Off grid",
      "KBS World Radio",
      "KBS World Radio",
    ]);
    expect(scheduledBetween(schedule, 9_579, 9_590, noon).map((c) => [c.khz, c.broadcasts.length])).toEqual([
      [9_579, 1],
      [9_580, 2],
      [9_580.4, 1],
      [9_590, 1],
    ]);
  });

  // Value: protects=a line names the first broadcast and its languages, counts the rest, lists all for the tooltip, and leaves out language codes it doesn't know; the waterfall's short label is the name and a count only; fails_when=a shared frequency hides that others share it, or a raw code like "M" shows; why_new=plan: "9,580 · Radio Australia · English"; seam=none; no_claim=none
  it("words a frequency's line", () => {
    expect(shortLabel([])).toBeNull();
    expect(shortLabel([b({ station: "Voice of Turkey" })])).toBe("Voice of Turkey");
    expect(shortLabel([b({ station: "Voice of Turkey" }), b({ station: "BBC" }), b({})])).toBe("Voice of Turkey +2");
    expect(languageNames("F,E")).toBe("French, English");
    expect(languageNames("-TS")).toBe("Time signal");
    expect(languageNames("ZZZ")).toBe("");
    expect(stationLine([])).toBeNull();
    expect(stationLine([b({ lang: "ZZZ" })])).toEqual({ text: "Radio X", all: "Radio X" });
    expect(stationLine([b({}), b({ station: "Radio Y", lang: "M" })])).toEqual({
      text: "Radio X · English +1 more",
      all: "Radio X · English\nRadio Y · Mandarin",
    });
  });
});
