import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  describeChanges,
  diffSchedules,
  mergeSlices,
  nextTx,
  onAirTx,
  parsePriyomEvents,
  PRIYOM_EVENTS_URL,
  PRIYOM_ON_AIR_MS,
  PRIYOM_SLICES,
  priyomSliceUrls,
  type PriyomTx,
} from "./priyom-schedule";

/** Ten real events from calendar2.priyom.org (2026-11-25), one of each summary shape. */
const EVENTS = JSON.parse(readFileSync(new URL("./fixtures/priyom-events.json", import.meta.url), "utf8"));
const at = (iso: string) => Date.parse(iso);
const tx = (station: string, iso: string, khz: number | null = 10_000): PriyomTx => ({
  station,
  startMs: at(iso),
  khz,
  mode: khz === null ? null : "usb",
  summary: `${station} ${khz ?? "Search"}`,
});

describe("parsePriyomEvents", () => {
  // Value: protects=every summary shape Priyom's calendar uses reads right: station, start, the frequency in kHz and the mode the dial takes (USB/AM as USB, CW as CW), with bracketed targets and "(May not always transmit)" notes ignored; fails_when=the pattern drifts from Priyom's, a target or note is read as the mode, or USB/AM isn't tuned; why_new=new feed (#98, owner's OK to use Priyom); seam=none; no_claim=that Priyom keeps this format
  it("reads station, start, frequency and mode from real events", () => {
    const byStation = Object.fromEntries(parsePriyomEvents(EVENTS).map((t) => [`${t.station} ${t.khz ?? "search"}`, t]));
    expect(byStation["E07 17428"]).toMatchObject({ startMs: at("2026-11-26T10:00:00Z"), mode: "usb" });
    expect(byStation["S06 11616"]).toMatchObject({ mode: "usb" }); // USB/AM [Target: Pacific]
    expect(byStation["M12 12135"]).toMatchObject({ mode: "cw" });
    expect(byStation["M14 17458"]).toMatchObject({ mode: "cw" }); // (May not always transmit)
  });

  // Value: protects="Search" events (Priyom doesn't know the frequency yet) keep their time with no frequency, and data modes (RTTY) keep the frequency but have no tuned mode, so Listen is never offered on a guess; fails_when="Search" is dropped or read as a station name, or RTTY is tuned as voice; why_new=new feed (#98); seam=none; no_claim=none
  it("keeps Search events without a frequency and data modes without a mode", () => {
    const txs = parsePriyomEvents(EVENTS);
    expect(txs.find((t) => t.station === "M12" && t.khz === null)).toMatchObject({ mode: null, startMs: at("2026-11-26T04:00:00Z") });
    expect(txs.find((t) => t.station === "F03")).toMatchObject({ khz: null, mode: null });
    expect(txs.find((t) => t.station === "F06a")).toMatchObject({ khz: 17_532, mode: null });
    expect(txs).toHaveLength(10);
  });

  // Value: protects=a response that isn't the calendar's shape throws (so the server keeps its last good copy) while single unreadable events are skipped; fails_when=an error page parses as an empty schedule and wipes "up next", or one bad event fails the whole week; why_new=new feed (#98); seam=none; no_claim=none
  it("throws on a response that isn't the event list, and skips unreadable events", () => {
    expect(() => parsePriyomEvents({ error: "rate limited" })).toThrow();
    expect(() => parsePriyomEvents(null)).toThrow();
    const txs = parsePriyomEvents({
      items: [
        { summary: "E11 8102kHz USB", start: { date: "2026-11-25" } }, // all-day: no dateTime
        { summary: "Maintenance notice", start: { dateTime: "2026-11-25T00:00:00Z" } },
        { summary: 42, start: { dateTime: "2026-11-25T00:00:00Z" } },
        { summary: "E11 8102kHz USB", start: { dateTime: "not a date" } },
        { summary: "E11 8102kHz USB", start: { dateTime: "2026-11-25T03:15:00.000Z" } },
      ],
    });
    expect(txs.map((t) => t.summary)).toEqual(["E11 8102kHz USB"]);
  });
});

describe("priyomSliceUrls", () => {
  // Value: protects=the server asks for a week as day-long slices starting on the 00:00/12:00 UTC boundary before now, as Priyom's page does (shared cache, each under the API's 250-event limit); fails_when=one week-long request is made (truncated at 250), slices leave gaps, or the start isn't aligned; why_new=new feed (#98); seam=none; no_claim=Priyom's cache behaviour
  it("asks for seven aligned day-long slices", () => {
    const urls = priyomSliceUrls(at("2026-11-25T13:37:00Z"));
    expect(urls).toHaveLength(PRIYOM_SLICES);
    expect(urls[0]).toBe(`${PRIYOM_EVENTS_URL}?timeMin=2026-11-25T12:00:00.000Z&timeMax=2026-11-26T12:00:00.000Z`);
    expect(urls[6]).toBe(`${PRIYOM_EVENTS_URL}?timeMin=2026-12-01T12:00:00.000Z&timeMax=2026-12-02T12:00:00.000Z`);
  });
});

describe("mergeSlices", () => {
  // Value: protects=an event returned by two slices is kept once and the week comes out in time order; fails_when=a boundary event doubles in "up next" or slices stay in fetch order; why_new=new feed (#98); seam=none; no_claim=none
  it("dedupes and sorts", () => {
    const a = tx("E11", "2026-11-25T12:00:00Z");
    const b = tx("E11", "2026-11-25T09:00:00Z");
    expect(mergeSlices([[a], [a, b]])).toEqual([b, a]);
  });
});

describe("onAirTx and nextTx", () => {
  const txs = [
    tx("E11", "2026-11-25T07:15:00Z", 20_167),
    tx("E11", "2026-11-25T07:45:00Z", 17_378),
    tx("S11a", "2026-11-25T07:35:00Z", 19_515),
  ];

  // Value: protects=a transmission is on the air from its start for PRIYOM_ON_AIR_MS (half-open), for its own station only, and the next one is the soonest start strictly after now; fails_when=the window is closed at its end, another station's slot is returned, or a transmission starting now counts as "next"; why_new=new feed (#98); seam=none; no_claim=the real length of a transmission (Priyom gives none)
  it("finds the transmission on now and the next one", () => {
    expect(onAirTx(txs, "E11", at("2026-11-25T07:14:59Z"))).toBeNull();
    expect(onAirTx(txs, "E11", at("2026-11-25T07:15:00Z"))?.khz).toBe(20_167);
    expect(onAirTx(txs, "E11", at("2026-11-25T07:15:00Z") + PRIYOM_ON_AIR_MS - 1)?.khz).toBe(20_167);
    expect(onAirTx(txs, "E11", at("2026-11-25T07:15:00Z") + PRIYOM_ON_AIR_MS)).toBeNull();
    expect(onAirTx(txs, "E11", at("2026-11-25T07:36:00Z"))).toBeNull(); // S11a's slot
    expect(nextTx(txs, "E11", at("2026-11-25T07:15:00Z"))?.khz).toBe(17_378);
    expect(nextTx(txs, "E11", at("2026-11-25T07:45:00Z"))).toBeNull();
  });
});

describe("diffSchedules", () => {
  const span = { fromMs: at("2026-11-25T00:00:00Z"), toMs: at("2026-11-26T00:00:00Z") };

  // Value: protects=a refresh's changes are counted per station: a new frequency at the same time is "changed", a new time "added", a vanished one "removed", and an identical slot is no change; fails_when=a frequency change reads as one added plus one removed, or unchanged slots are reported; why_new=change log (owner asked 2026-11-25: Priyom's feed has no change marker); seam=none; no_claim=why Priyom changed it
  it("counts changed, added and removed slots per station", () => {
    const prev = [tx("E11", "2026-11-25T07:15:00Z", 8_102), tx("E11", "2026-11-25T07:45:00Z", 9_079), tx("M12", "2026-11-25T19:00:00Z", 12_135)];
    const next = [tx("E11", "2026-11-25T07:15:00Z", 20_167), tx("E11", "2026-11-25T08:20:00Z", 14_611), tx("M12", "2026-11-25T19:00:00Z", 12_135)];
    const changes = diffSchedules(prev, next, span);
    expect(changes).toEqual([{ station: "E11", added: 1, removed: 1, changed: 1 }]);
    expect(describeChanges(changes)).toBe("E11: 1 changed, 1 added, 1 removed");
    expect(diffSchedules(prev, prev, span)).toEqual([]);
  });

  // Value: protects=slots outside the time both fetches cover are not changes, so the window sliding forward by a day doesn't log every slot as added or removed; fails_when=the overlap is ignored and every refresh logs noise; why_new=change log; seam=none; no_claim=none
  it("ignores slots outside the overlap", () => {
    const prev = [tx("E11", "2026-11-24T23:00:00Z")];
    const next = [tx("E11", "2026-11-26T01:00:00Z")];
    expect(diffSchedules(prev, next, span)).toEqual([]);
  });
});
