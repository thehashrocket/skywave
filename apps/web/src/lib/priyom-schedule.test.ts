import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  describeChanges,
  diffSchedules,
  mergeSlices,
  nextFeedRecord,
  nextTx,
  onAirTx,
  parsePriyomEvents,
  PRIYOM_EVENTS_URL,
  PRIYOM_ON_AIR_MS,
  PRIYOM_SLICES,
  PRIYOM_UNCHANGED_MS,
  priyomSliceUrls,
  priyomSpan,
  priyomUnchanged,
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

  // Value: protects="Search" events (Priyom doesn't know the frequency yet) keep their time with no frequency, and an RTTY slot gets a USB dial RTTY_MARK_OFFSET_KHZ below its listed frequency, marked data (owner, #148 R15), with the listed frequency kept in the summary; fails_when="Search" is dropped or read as a station name, or RTTY is untunable, tuned at the listed kHz or as voice; why_new=#148 replaced #98's no-mode rule for data; seam=none; no_claim=mark-vs-centre on the air (TODOS live-slot check)
  it("keeps Search events without a frequency and tunes RTTY as USB below the mark", () => {
    const txs = parsePriyomEvents(EVENTS);
    expect(txs.find((t) => t.station === "M12" && t.khz === null)).toMatchObject({ mode: null, startMs: at("2026-11-26T04:00:00Z") });
    expect(txs.find((t) => t.station === "F03")).toMatchObject({ khz: null, mode: null });
    const f06 = txs.find((t) => t.station === "F06a")!;
    expect(f06).toMatchObject({ khz: 17_529.875, mode: "usb", data: true, listedKhz: 17_532 });
    expect(f06.summary).toContain("17532kHz");
    expect(txs).toHaveLength(10);
  });

  // Value: protects=R15's fallback beside the rules it must not swallow (owner, #148): an unknown mode ("MFSK") tunes USB at exactly the listed kHz, unmarked; RTTY next to it still tunes 2.125 kHz below, marked data; and a known mode spelled oddly by the feed (lowercase "lsb", "cw", whose fallback would wrongly be USB) stays on the known path; fails_when=the fallback drops the slot, shifts it like RTTY, catches RTTY, or a formatting quirk sends a known mode down the unknown path; why_new=plan audit: R15's unknown-mode rule had no test; seam=none; no_claim=what such a mode sounds like
  it("tunes an unknown mode as USB at the listed kHz without touching RTTY or oddly spelled known modes", () => {
    const at = (summary: string, iso: string) => ({ summary, start: { dateTime: iso } });
    const txs = parsePriyomEvents({
      items: [
        at("E11 12345kHz MFSK", "2026-11-26T10:00:00Z"),
        at("F06 17532kHz RTTY", "2026-11-26T10:10:00Z"),
        at("E07 14789kHz lsb", "2026-11-26T10:20:00Z"),
        at("M12 12135kHz cw", "2026-11-26T10:30:00Z"),
      ],
    });
    expect(txs.map(({ station, khz, mode, data }) => ({ station, khz, mode, data }))).toEqual([
      { station: "E11", khz: 12_345, mode: "usb", data: undefined },
      { station: "F06", khz: 17_529.875, mode: "usb", data: true },
      { station: "E07", khz: 14_789, mode: "lsb", data: undefined },
      { station: "M12", khz: 12_135, mode: "cw", data: undefined },
    ]);
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
  // Value: protects=the server asks for day-long slices aligned on 00:00/12:00 UTC, as Priyom's page does (shared cache, each under the API's 250-event limit), from 12 hours before the last boundary to at least a week ahead; fails_when=one week-long request is made (truncated at 250), slices leave gaps, the start isn't aligned, or the week ahead is cut short; why_new=new feed (#98), earlier start from #101's review; seam=none; no_claim=Priyom's cache behaviour
  it("asks for eight aligned day-long slices, from 12 hours before the last boundary", () => {
    const urls = priyomSliceUrls(at("2026-11-25T13:37:00Z"));
    expect(urls).toHaveLength(PRIYOM_SLICES);
    expect(urls[0]).toBe(`${PRIYOM_EVENTS_URL}?timeMin=2026-11-25T00:00:00.000Z&timeMax=2026-11-26T00:00:00.000Z`);
    expect(urls[7]).toBe(`${PRIYOM_EVENTS_URL}?timeMin=2026-12-02T00:00:00.000Z&timeMax=2026-12-03T00:00:00.000Z`);
  });

  // Value: protects=a fetch just after a 00:00/12:00 boundary still covers a transmission that began just before it, so the server can vouch for an answer about it and the panel still shows it on; fails_when=the copy starts at the boundary, and a correct answer about an 11:57 transmission is refused after a 12:01 fetch; why_new=#101 review (important); seam=none; no_claim=none
  it("covers a transmission that began just before the boundary", () => {
    expect(priyomSpan(at("2026-11-25T12:01:00Z")).fromMs).toBeLessThanOrEqual(at("2026-11-25T11:57:00Z"));
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

describe("nextFeedRecord and priyomUnchanged", () => {
  const DAY = 24 * 60 * 60_000;
  const t0 = at("2026-11-25T13:00:00Z");
  const week = [tx("E11", "2026-11-26T20:00:00Z"), tx("E07", "2026-11-27T19:00:00Z", 17_428)];
  const first = nextFeedRecord(null, { transmissions: week, fetchedAt: t0 });

  // Value: protects=#147 the shared record's last-changed time moves to a fetch whose future slots differ from the last copy (here E07 moving 17428 to 9999 kHz), and stays put through an identical fetch hours later; the first fetch starts tracking with no change; fails_when=every fetch counts as a change (so a dead feed never looks unmaintained) or a real change is missed; why_new=#147 persisted last change; seam=none (pure); no_claim=the database write (recordPriyomFetch)
  it("moves the last change only when the slots differ", () => {
    expect(first).toEqual({ transmissions: week, fetchedAt: t0, trackedSince: t0, changedAt: null });
    const same = nextFeedRecord(first, { transmissions: week, fetchedAt: t0 + 6 * 3_600_000 });
    expect(same).toMatchObject({ fetchedAt: t0 + 6 * 3_600_000, trackedSince: t0, changedAt: null });
    const moved = [week[0]!, { ...week[1]!, khz: 9_999 }];
    const t2 = t0 + 12 * 3_600_000;
    const changed = nextFeedRecord(same, { transmissions: moved, fetchedAt: t2 });
    expect(changed).toMatchObject({ fetchedAt: t2, trackedSince: t0, changedAt: t2, transmissions: moved });
    expect(nextFeedRecord(changed, { transmissions: moved, fetchedAt: t2 + 3_600_000 }).changedAt).toBe(t2);
  });

  // Value: protects=#147 a copy no newer than the record's (another instance saved a later one first) leaves the record as it is; fails_when=an older copy overwrites a newer one and reports a change back in time; why_new=#147; seam=none; no_claim=none
  it("keeps the record when the copy is older", () => {
    const later = nextFeedRecord(first, { transmissions: week, fetchedAt: t0 + DAY });
    expect(nextFeedRecord(later, { transmissions: [], fetchedAt: t0 })).toBe(later);
  });

  // Value: protects=#147 the report flags Priyom's schedule as possibly unmaintained once the last change (or, with none seen, the start of tracking) is over 45 days old, and not at 44; fails_when=the threshold drifts or a feed with no change since tracking began is never flagged; why_new=#147 acceptance; seam=none; no_claim=none
  it("flags no change in over 45 days, not 44", () => {
    expect(PRIYOM_UNCHANGED_MS).toBe(45 * DAY);
    const changedAt = t0;
    expect(priyomUnchanged({ trackedSince: t0 - 90 * DAY, changedAt }, t0 + 44 * DAY)).toBe(false);
    expect(priyomUnchanged({ trackedSince: t0 - 90 * DAY, changedAt }, t0 + 46 * DAY)).toBe(true);
    expect(priyomUnchanged({ trackedSince: t0, changedAt: null }, t0 + 44 * DAY)).toBe(false);
    expect(priyomUnchanged({ trackedSince: t0, changedAt: null }, t0 + 46 * DAY)).toBe(true);
  });
});
