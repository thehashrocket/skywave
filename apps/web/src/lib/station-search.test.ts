import { describe, expect, it } from "vitest";
import type { Broadcast } from "./eibi";
import { fold, langLabel, searchStations } from "./station-search";

const at = (iso: string) => Date.parse(iso);
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
// 14:00 UTC on a Wednesday.
const NOW = at("2026-11-18T14:00:00Z");

describe("searchStations", () => {
  // Value: protects=a name matches on every query word, in any order, ignoring case and accents; fails_when=the query must match from the start, in order, or with the file's accents; why_new=station search (Charles Harlich's request); seam=none; no_claim=fuzzy or misspelled names
  it("matches every word, in any order, without case or accents", () => {
    const schedule = [b({ station: "Radio Fránce Internationale" }), b({ station: "Radio Romania Int" })];
    expect(searchStations(schedule, "INTERNATIONALE france", NOW).map((m) => m.station)).toEqual([
      "Radio Fránce Internationale",
    ]);
    expect(searchStations(schedule, "radio", NOW)).toHaveLength(2);
    expect(fold("Rádio Nacional")).toBe("radio nacional");
  });

  // Value: protects=a query under two letters returns nothing instead of half the schedule; fails_when=one letter or spaces list every station; why_new=station search; seam=none; no_claim=none beyond protects
  it("waits for two letters", () => {
    expect(searchStations([b({})], "r", NOW)).toEqual([]);
    expect(searchStations([b({})], "   ", NOW)).toEqual([]);
  });

  // Value: protects=one entry per station, its on-air frequencies lowest first with languages from each transmitter row merged; fails_when=a station repeats per row or a frequency per site; why_new=station search; seam=none; no_claim=which transmitter is heard
  it("groups a station's rows and merges languages on a frequency", () => {
    const schedule = [
      b({ station: "BBC", khz: 15_400, lang: "E" }),
      b({ station: "BBC", khz: 9_410, lang: "E" }),
      b({ station: "BBC", khz: 9_410, lang: "F" }),
      b({ station: "BBC", khz: 9_410, lang: "E" }),
    ];
    expect(searchStations(schedule, "bbc", NOW)).toEqual([
      {
        station: "BBC",
        now: [
          { khz: 9_410, lang: "E,F", target: "Eu" },
          { khz: 15_400, lang: "E", target: "Eu" },
        ],
        next: undefined,
      },
    ]);
  });

  // Value: protects=stations on the air now come first, then those off by how soon they start, with the next start's frequency and time; fails_when=an off station outranks one on now or the next start is the wrong row or day; why_new=links search to what's on now; seam=none; no_claim=schedule accuracy
  it("puts what's on now first and says when the rest are next on", () => {
    const schedule = [
      b({ station: "Radio Late", khz: 6_000, start: 20 * 60, end: 21 * 60 }),
      b({ station: "Radio Soon", khz: 7_000, start: 16 * 60, end: 17 * 60 }),
      b({ station: "Radio Soon", khz: 7_100, start: 15 * 60, end: 16 * 60 }),
      b({ station: "Radio Now", khz: 5_000, start: 13 * 60, end: 15 * 60 }),
    ];
    const found = searchStations(schedule, "radio", NOW);
    expect(found.map((m) => m.station)).toEqual(["Radio Now", "Radio Soon", "Radio Late"]);
    expect(found[1]!.next).toEqual({ khz: 7_100, lang: "E", at: at("2026-11-18T15:00:00Z") });
  });

  // Value: protects=a next start already past today rolls to tomorrow, and one on a day it doesn't run is skipped; fails_when=it reports a time in the past or a weekday it's off; why_new=station search; seam=onAirAt days rules; no_claim=starts more than a day out
  it("looks a day ahead, honouring the days field", () => {
    const tomorrow = [b({ station: "Radio Morning", start: 6 * 60, end: 7 * 60 })];
    expect(searchStations(tomorrow, "morning", NOW)[0]!.next?.at).toBe(at("2026-11-19T06:00:00Z"));
    // Thursday is 4 in ISO; Mondays only means nothing in the next day.
    const mondays = [b({ station: "Radio Monday", start: 6 * 60, end: 7 * 60, days: "1" })];
    expect(searchStations(mondays, "monday", NOW)[0]!.next).toBeUndefined();
  });

  // Value: protects=unknown language codes still show as the code; fails_when=an unlisted code renders an empty label; why_new=station search; seam=languageNames; no_claim=none beyond protects
  it("labels unknown languages by their code", () => {
    expect(langLabel("E")).toBe("English");
    expect(langLabel("ZZQ")).toBe("ZZQ");
  });
});
