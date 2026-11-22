import { describe, expect, it } from "vitest";
import type { Broadcast } from "./eibi";
import { clickMode, findBroadcasts, fold, startsParts, startsSentence } from "./station-search";

const MIN = 60_000;
/** Thursday 19 November 2026, 12:00 UTC, in season b26. */
const NOW = Date.UTC(2026, 10, 19, 12, 0);

const b = (station: string, khz: number, start: string, end: string, more: Partial<Broadcast> = {}): Broadcast => ({
  khz,
  start: Number(start.slice(0, 2)) * 60 + Number(start.slice(2)),
  end: Number(end.slice(0, 2)) * 60 + Number(end.slice(2)),
  days: "",
  station,
  lang: "E",
  target: "Eu",
  ...more,
});

const find = (schedule: Broadcast[], query: string, ms = NOW, season = "b26") =>
  findBroadcasts(schedule, query, ms, season);
const rows = (schedule: Broadcast[], query: string, ms = NOW) =>
  find(schedule, query, ms).found.map(
    (f) => `${f.khz} ${f.station} ${f.onNow ? "now" : new Date(f.startsAt!).toISOString().slice(5, 16)}`,
  );

describe("station search", () => {
  // Value: protects=a name is found however it's typed: any case, without accents or EiBi's other letters, words in any order and in part, and EiBi's short forms spelled out (R., VoA, Int., Ext., Sce, BC, Bc.); fails_when=an accent, ø, a short form or word order makes a station unfindable, or a name matches on only some of the words; why_new=station search D8 (owner raised the short forms); seam=none; no_claim=short forms not in the table
  it("matches names as listeners type them", () => {
    const schedule = [
      b("Rádio Nacional Amazônia", 6180, "1100", "1300"),
      b("Bjørnøya Radio", 1757, "1100", "1300"),
      b("R.Triunfal Evangélica", 5825, "1100", "1300"),
      b("VoA Radio Ashna", 12140, "1100", "1300"),
      b("Radio Taiwan Int.", 9440, "1100", "1300"),
      b("AIR Akashvani Ext.Sce", 9445, "1100", "1300"),
      b("Sri Lanka BC", 11905, "1100", "1300"),
      b("Fu Hsing Bc.Sta.", 9410, "1100", "1300"),
    ];
    const names = (q: string) => find(schedule, q).names;
    expect(names("radio nacional")).toEqual(["Rádio Nacional Amazônia"]);
    expect(names("AMAZONIA nacional")).toEqual(["Rádio Nacional Amazônia"]);
    expect(names("bjornoya")).toEqual(["Bjørnøya Radio"]);
    expect(names("radio triunfal")).toEqual(["R.Triunfal Evangélica"]);
    expect(names("r.triunfal")).toEqual(["R.Triunfal Evangélica"]);
    expect(names("voice of america ashna")).toEqual(["VoA Radio Ashna"]);
    expect(names("taiwan international")).toEqual(["Radio Taiwan Int."]);
    expect(names("external service")).toEqual(["AIR Akashvani Ext.Sce"]);
    expect(names("sri lanka broadcasting")).toEqual(["Sri Lanka BC"]);
    expect(names("hsing broadcasting")).toEqual(["Fu Hsing Bc.Sta."]);
    expect(names("radio france")).toEqual([]);
    expect(names("   ")).toEqual([]);
    expect(fold("Ærø Straße")).toBe("aero strasse");
  });

  // Value: protects=results are what's on now, then what starts in the next 24 h by start time, over midnight included, with a broadcast's days obeyed and a slot on now never repeated as "later"; fails_when=a Saturday-only slot shows on Thursday, a 2330-0130 slot is missed after midnight, a daily slot on now also appears for tomorrow, or later rows sort by frequency; why_new=station search D1 and the eng outside voice (no on-now/later overlap); seam=none; no_claim=EiBi day codes onDay can't read (shown as on)
  it("lists on now first, then the next 24 hours", () => {
    const schedule = [
      b("Test Radio", 9500, "1100", "1300"), // on now, daily: not repeated tomorrow
      b("Test Radio", 7300, "1130", "1230"),
      b("Test Radio", 6000, "1800", "1900"),
      b("Test Radio", 5900, "0600", "0700"), // tomorrow morning
      b("Test Radio", 11700, "1400", "1500", { days: "Sa" }), // Thursday: not within 24 h
      b("Test Radio", 15100, "2330", "0130"),
    ];
    expect(rows(schedule, "test")).toEqual([
      "7300 Test Radio now",
      "9500 Test Radio now",
      "6000 Test Radio 11-19T18:00",
      "15100 Test Radio 11-19T23:30",
      "5900 Test Radio 11-20T06:00",
    ]);
    // Past midnight, the over-midnight slot is on now (it began the day before).
    expect(rows(schedule, "test", Date.UTC(2026, 10, 20, 0, 30))[0]).toBe("15100 Test Radio now");
  });

  // Value: protects=each listing is checked on its own before merging, so a twin listing whose dates ended or whose days don't fit can't hide the one that's on, and merged listings keep every target, blanks left out; fails_when=dedupe runs first and the expired VFF Iqaluit-style twin or the Mo-Fr half of an RNZ-style pair wins, or a second target is dropped; why_new=eng re-check (Codex, native fallback) and re-check D4; seam=none; no_claim=none beyond protects
  it("merges listings only after checking each, keeping every target", () => {
    const schedule = [
      b("VFF Iqaluit Radio", 2514, "0000", "2400", { to: "3110", target: "NAm" }), // ended 31 October
      b("VFF Iqaluit Radio", 2514, "0000", "2400", { to: "2012", target: "NAm" }),
      b("RNZ Pacific", 9700, "1059", "1258", { days: "Sa,Su" }),
      b("RNZ Pacific", 9700, "1059", "1258", { days: "Mo-Fr" }),
      b("China Radio Int.", 6180, "1100", "1300", { target: "SAs" }),
      b("China Radio Int.", 6180, "1100", "1300", { target: "ENA" }),
      b("China Radio Int.", 6180, "1100", "1300", { target: "" }),
      b("China Radio Int.", 6180, "1100", "1300", { target: "SAs" }),
    ];
    const found = find(schedule, "radio").found;
    expect(found.map((f) => [f.station, f.onNow, f.targets])).toEqual([
      ["VFF Iqaluit Radio", true, ["NAm"]],
      ["China Radio Int.", true, ["SAs", "ENA"]],
    ]);
    expect(find(schedule, "rnz").found.map((f) => [f.khz, f.onNow])).toEqual([[9700, true]]);
  });

  // Value: protects=a "later" row never runs past the season change, since the next season lists other frequencies, while on-now rows are untouched; fails_when=the day before a switch promises a frequency from the ending season; why_new=station search D7; seam=none; no_claim=the next season's listings (not loaded)
  it("stops later rows at the season change", () => {
    const schedule = [
      b("Edge Radio", 9500, "1800", "1900"),
      b("Edge Radio", 6000, "0600", "0700"),
      b("Edge Radio", 7200, "1100", "1300"),
    ];
    // a27 starts 28 March 2027 at 00:00 UTC; this is 27 March, 12:00, still b26.
    expect(rows(schedule, "edge", Date.UTC(2027, 2, 27, 12, 0))).toEqual([
      "7200 Edge Radio now",
      "9500 Edge Radio 03-27T18:00",
    ]);
  });

  // Value: protects=an empty result says why: the station names that matched are reported even when none is on in the next 24 hours, and none when the name matches nothing; fails_when=a correctly typed station that's off today reads as a spelling mistake; why_new=design review 4A; seam=none; no_claim=none beyond protects
  it("reports matching names even when nothing is on", () => {
    const schedule = [b("NHK Radio Japan", 9750, "0000", "0100", { days: "Sa" })];
    expect(find(schedule, "radio japan")).toEqual({ found: [], names: ["NHK Radio Japan"] });
    expect(find(schedule, "radio xyz")).toEqual({ found: [], names: [] });
  });

  // Value: protects=a click tunes AM on long/medium wave, in the broadcast bands and for out-of-band broadcasters, what the dial picks in a ham band, and USB only in the HF aeronautical and maritime mobile bands; fails_when=VoA Ashna on 12,140 or R.Triunfal on 5,825 tune USB, Volmet tunes AM, or a 40 m row ignores the ham rule; why_new=station search D11, reopened at build (owner: ITU mobile bands); seam=none; no_claim=DRM and data rows, noise in any mode
  it("picks the mode a result tunes in", () => {
    const cases: [number, string][] = [
      [198, "am"],
      [1000, "am"],
      [9580, "am"],
      [12140, "am"],
      [5825, "am"],
      [7580, "am"],
      [2863, "usb"],
      [8957, "usb"],
      [4357, "usb"],
      [7150, "lsb"],
      [14250, "usb"],
    ];
    expect(cases.map(([k]) => [k, clickMode(k)])).toEqual(cases);
  });

  // Value: protects=a later row's start reads as UTC time plus how long until it, "tomorrow" once past midnight UTC, in a row and in the note's sentence; fails_when=minutes round down to 0, hours read as minutes, or a start after midnight looks like today; why_new=design review 7A; seam=none; no_claim=the viewer's local time
  it("words when a later broadcast starts", () => {
    expect(startsParts(NOW + 40 * MIN, NOW)).toEqual({ time: "12:40 UTC", until: "in 40 min" });
    expect(startsParts(NOW + 30_000, NOW)).toEqual({ time: "12:00 UTC", until: "in 1 min" });
    expect(startsParts(NOW + 180 * MIN, NOW).until).toBe("in 3 h");
    expect(startsParts(NOW + 200 * MIN, NOW).until).toBe("in 3 h 20 min");
    expect(startsParts(Date.UTC(2026, 10, 20, 6, 0), NOW)).toEqual({ time: "06:00 UTC", until: "tomorrow, in 18 h" });
    expect(startsSentence(NOW + 40 * MIN, NOW)).toBe("starts at 12:40 UTC, in 40 min");
    expect(startsSentence(Date.UTC(2026, 10, 20, 6, 0), NOW)).toBe("starts tomorrow at 06:00 UTC, in 18 h");
  });
});
