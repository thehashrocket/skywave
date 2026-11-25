import { describe, expect, it } from "vitest";
import { inTuneRange, isMode } from "./radio-types";
import {
  activeChannelAt,
  findStation,
  nextStartAfter,
  onAirAt,
  SIGNAL_STATIONS,
  type Schedule,
  type SignalStation,
} from "./signal-stations";

const at = (iso: string) => Date.parse(iso);
const hhmm = (h: number, m = 0) => h * 60 + m;

/** A made-up station: no real one in the catalog has windows yet. */
function station(schedule: Schedule): SignalStation {
  return {
    slug: "test",
    name: "Test",
    aka: [],
    category: "other",
    channels: [
      { khz: 6_000, mode: "usb" },
      { khz: 9_000, mode: "usb" },
    ],
    schedule,
    tx: { lat: 0, lon: 0, label: "Nowhere", confidence: "country" },
    blurb: "",
    sources: [],
  };
}

// 2026-11-23 is a Monday, 2026-11-28 a Saturday, 2026-11-29 a Sunday.
const MONDAY = "2026-11-23";

describe("onAirAt", () => {
  // Value: protects=an always-on station (WWV) is on at any time, including midnight UTC and the far past and future; fails_when=always-on is wired through the window logic or a clock edge; why_new=new catalog (#98); seam=none; no_claim=that WWV is actually transmitting
  it.each(["2026-11-23T00:00:00Z", "2026-11-23T13:37:00Z", "1990-01-01T00:00:00Z", "2040-06-30T23:59:59Z"])(
    "an always-on station is on at %s",
    (iso) => {
      expect(onAirAt(findStation("wwv")!, at(iso))).toBe(true);
    },
  );

  // Value: protects=a window past midnight UTC (2300-0100) is on both sides of midnight and off at its end, half-open; fails_when=the end is read as before the start, the day before isn't checked, or a boundary is closed; why_new=new schedule logic; seam=none; no_claim=none
  it.each([
    ["T22:59:59Z", false],
    ["T23:00:00Z", true],
    ["T23:59:59Z", true],
    ["T00:00:00Z", true],
    ["T00:59:59Z", true],
    ["T01:00:00Z", false],
  ])("a 2300-0100 window at %s is %s", (time, on) => {
    const s = station({ kind: "windows", windows: [{ startUtc: hhmm(23), endUtc: hhmm(1), khz: 6_000 }] });
    expect(onAirAt(s, at(`2026-11-24${time}`))).toBe(on);
  });

  // Value: protects=a day filter ("Mo-Fr") keeps a weekday window off on the weekend, and a past-midnight window counts from the day it started (EiBi's rule): Friday 2300-0100 still runs early Saturday, Sunday's doesn't run into Monday; fails_when=the days field is ignored or applied to the day the window ends; why_new=new schedule logic, reusing eibi onDay; seam=eibi.onDay; no_claim=EiBi's other day formats (eibi.test covers them)
  it.each([
    ["2026-11-27T12:00:00Z", true], // Friday
    ["2026-11-28T12:00:00Z", false], // Saturday
    ["2026-11-29T12:00:00Z", false], // Sunday
    ["2026-11-27T23:30:00Z", true], // Friday's late window
    ["2026-11-28T00:30:00Z", true], // ...still on into Saturday
    ["2026-11-29T23:30:00Z", false], // Sunday's isn't
    ["2026-11-30T00:30:00Z", false], // ...so nothing into Monday
  ])("a Mo-Fr station at %s is %s", (iso, on) => {
    const s = station({
      kind: "windows",
      windows: [
        { days: "Mo-Fr", startUtc: hhmm(12), endUtc: hhmm(13), khz: 6_000 },
        { days: "Mo-Fr", startUtc: hhmm(23), endUtc: hhmm(1), khz: 9_000 },
      ],
    });
    expect(onAirAt(s, at(iso))).toBe(on);
  });

  // Value: protects=a window whose end equals its start runs a full 24 hours with no gap at midnight, and a day filter limits it to that one day; fails_when=end <= start becomes end < start (a zero-length window) or midnight is double-counted or dropped; why_new=new schedule logic; seam=eibi.onDay; no_claim=none
  it.each([
    ["2026-11-22T23:59:59Z", false], // Sunday
    ["2026-11-23T00:00:00Z", true], // Monday
    ["2026-11-23T12:00:00Z", true],
    ["2026-11-23T23:59:59Z", true],
    ["2026-11-24T00:00:00Z", false], // Tuesday
  ])("a Monday-only 24-hour window at %s is %s", (iso, on) => {
    const s = station({ kind: "windows", windows: [{ days: "Mo", startUtc: 0, endUtc: 0, khz: 6_000 }] });
    expect(onAirAt(s, at(iso))).toBe(on);
  });

  // Value: protects=defunct and irregular stations are never on air, so the panel never offers Listen into dead air for them; fails_when=either kind falls through to "on"; why_new=new catalog (#98, #104's dead-air rule); seam=none; no_claim=none
  it.each(["chu", "lincolnshire-poacher", "e07", "e11", "m12"])("%s is never on", (slug) => {
    const s = findStation(slug)!;
    for (const iso of ["2026-11-23T00:00:00Z", "2026-11-25T12:00:00Z", "2026-11-28T23:30:00Z"]) {
      expect(onAirAt(s, at(iso))).toBe(false);
      expect(activeChannelAt(s, at(iso))).toBeNull();
      expect(nextStartAfter(s, at(iso))).toBeNull();
    }
  });
});

describe("activeChannelAt", () => {
  // Value: protects=the channel follows the open window (day 6000, night 9000), and an always-on station gives its main channel; fails_when=the first channel is returned regardless of window, or the window's khz lookup breaks; why_new=new function; seam=none; no_claim=which band suits a listener (#99)
  it("follows the open window, and gives an always-on station's main channel", () => {
    const s = station({
      kind: "windows",
      windows: [
        { startUtc: hhmm(6), endUtc: hhmm(18), khz: 6_000 },
        { startUtc: hhmm(18), endUtc: hhmm(6), khz: 9_000 },
      ],
    });
    expect(activeChannelAt(s, at(`${MONDAY}T12:00:00Z`))?.khz).toBe(6_000);
    expect(activeChannelAt(s, at(`${MONDAY}T03:00:00Z`))?.khz).toBe(9_000);
    expect(activeChannelAt(findStation("uvb-76")!, at(`${MONDAY}T03:00:00Z`))).toEqual({ khz: 4_625, mode: "usb" });
  });
});

describe("day/night stations", () => {
  // Value: protects=The Pip is on air at all hours and Listen tunes 5448 kHz when the sun is up at Rostov-on-Don and 3756 kHz when it has set (owner's choice: the sun at the transmitter, since switch times aren't published); fails_when=a day/night station always gives its first channel (half the day in dead air), the day/night test is inverted, or it's read at the listener instead of the transmitter; why_new=new schedule kind (#98); seam=solar.isNight; no_claim=the real switch times, which can differ around dawn and dusk
  it.each([
    ["2026-06-21T10:00:00Z", 5_448], // 13:00 local in midsummer
    ["2026-12-21T22:00:00Z", 3_756], // 01:00 local in midwinter
    ["2026-12-21T11:00:00Z", 5_448], // midday in midwinter
  ])("The Pip at %s tunes %s kHz", (iso, khz) => {
    const pip = findStation("the-pip")!;
    expect(onAirAt(pip, at(iso))).toBe(true);
    expect(activeChannelAt(pip, at(iso))?.khz).toBe(khz);
    expect(nextStartAfter(pip, at(iso))).toBeNull();
  });
});

describe("nextStartAfter", () => {
  // Value: protects=the next start rolls to tomorrow once today's window has started, and is strictly after the time asked (a window opening now is not "next"); fails_when=today's past start is returned or the comparison is >= instead of >; why_new=new function; seam=none; no_claim=none
  it("rolls to the next day once today's start has passed", () => {
    const s = station({ kind: "windows", windows: [{ startUtc: hhmm(12), endUtc: hhmm(13), khz: 6_000 }] });
    expect(nextStartAfter(s, at(`${MONDAY}T11:00:00Z`))).toBe(at(`${MONDAY}T12:00:00Z`));
    expect(nextStartAfter(s, at(`${MONDAY}T12:00:00Z`))).toBe(at("2026-11-24T12:00:00Z"));
    expect(nextStartAfter(s, at(`${MONDAY}T12:30:00Z`))).toBe(at("2026-11-24T12:00:00Z"));
  });

  // Value: protects=a weekly window (Saturday only) rolls a full week ahead once it has started, and the soonest of several windows wins; fails_when=the day filter is skipped in the lookahead, the search stops short of 7 days, or windows aren't compared; why_new=new function; seam=eibi.onDay; no_claim=none
  it("rolls to next week for a once-a-week window, and picks the soonest window", () => {
    const weekly = station({ kind: "windows", windows: [{ days: "Sa", startUtc: hhmm(7, 20), endUtc: hhmm(7, 40), khz: 6_000 }] });
    expect(nextStartAfter(weekly, at(`${MONDAY}T00:00:00Z`))).toBe(at("2026-11-28T07:20:00Z"));
    expect(nextStartAfter(weekly, at("2026-11-28T07:20:00Z"))).toBe(at("2026-12-05T07:20:00Z"));

    const two = station({
      kind: "windows",
      windows: [
        { days: "Sa", startUtc: hhmm(7), endUtc: hhmm(8), khz: 6_000 },
        { days: "We", startUtc: hhmm(20), endUtc: hhmm(21), khz: 9_000 },
      ],
    });
    expect(nextStartAfter(two, at(`${MONDAY}T00:00:00Z`))).toBe(at("2026-11-25T20:00:00Z"));
  });

  // Value: protects=for a Friday-only window past midnight (2300-0100), the next start is Friday 2300 even when asked early Saturday while it is still on, so the day filter goes by the start day here too; fails_when=nextStartAfter applies days to the end day or returns the open window's start; why_new=new function; seam=eibi.onDay; no_claim=none
  it("keys a past-midnight window's next start to its start day", () => {
    const s = station({ kind: "windows", windows: [{ days: "Fr", startUtc: hhmm(23), endUtc: hhmm(1), khz: 6_000 }] });
    expect(nextStartAfter(s, at(`${MONDAY}T00:00:00Z`))).toBe(at("2026-11-27T23:00:00Z"));
    expect(nextStartAfter(s, at("2026-11-28T00:30:00Z"))).toBe(at("2026-12-04T23:00:00Z"));
  });

  // Value: protects=a window whose day never comes within 7 days ("1Jan" in late November) gives null, and always-on stations give null; fails_when=the lookahead runs unbounded or treats always-on as having a start; why_new=new function; seam=eibi.onDay; no_claim=none
  it("is null beyond 7 days and for always-on stations", () => {
    const yearly = station({ kind: "windows", windows: [{ days: "1Jan", startUtc: hhmm(0), endUtc: hhmm(1), khz: 6_000 }] });
    expect(nextStartAfter(yearly, at(`${MONDAY}T00:00:00Z`))).toBeNull();
    expect(nextStartAfter(findStation("wwv")!, at(`${MONDAY}T00:00:00Z`))).toBeNull();
  });
});

describe("SIGNAL_STATIONS", () => {
  // Value: protects=the hand-edited catalog stays usable: unique slugs, tunable channels in a real mode, window and day/night frequencies among the channels, window times within a day, a transmitter (ranking, #99) for every station still on the air and a channel (Listen) for every one with a schedule, and sources on every entry; fails_when=a typo or copy-paste breaks an entry; why_new=new catalog (#98); seam=radio-types; no_claim=that the facts are right (sources and the Priyom check cover that)
  it("is well formed", () => {
    const slugs = SIGNAL_STATIONS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of SIGNAL_STATIONS) {
      expect(s.slug, s.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s.sources.length, s.slug).toBeGreaterThan(0);
      for (const c of s.channels) {
        expect(inTuneRange(c.khz), `${s.slug} ${c.khz}`).toBe(true);
        expect(isMode(c.mode), `${s.slug} ${c.mode}`).toBe(true);
      }
      if (s.schedule.kind === "defunct") continue;
      expect(s.tx, s.slug).toBeDefined();
      if (s.schedule.kind !== "irregular") expect(s.channels.length, s.slug).toBeGreaterThan(0);
      const khzs = s.channels.map((c) => c.khz);
      if (s.schedule.kind === "windows")
        for (const w of s.schedule.windows) {
          expect(khzs, s.slug).toContain(w.khz);
          for (const m of [w.startUtc, w.endUtc]) expect(Number.isInteger(m) && m >= 0 && m < 1440, `${s.slug} ${m}`).toBe(true);
        }
      if (s.schedule.kind === "dayNight") expect(khzs, s.slug).toEqual(expect.arrayContaining([s.schedule.dayKhz, s.schedule.nightKhz]));
    }
  });
});
