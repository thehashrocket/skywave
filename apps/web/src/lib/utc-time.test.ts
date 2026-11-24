import { afterAll, describe, expect, it, vi } from "vitest";

// A zone west of UTC, set before anything is imported: CI runs in UTC, where a
// label that read the local clock by mistake would still pass. Restored after.
const previousTz = vi.hoisted(() => {
  const was = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  return was;
});
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

const { localLabel, savedLabel, savedTitle, utcClock, utcClockShort, utcDate, utcLabel, utcWeekday } =
  await import("./utc-time");

const at = (iso: string) => Date.parse(iso);

describe("utc-time", () => {
  // Value: protects=the test really runs in a zone where local and UTC days differ; fails_when=the TZ pin stops applying, so the UTC-vs-local cases below prove nothing; why_new=CI runs in UTC (eng review); seam=process.env.TZ; no_claim=other zones
  it("runs west of UTC", () => {
    expect(new Date(at("2026-11-24T01:30:00Z")).getDate()).toBe(23);
  });

  // Value: protects=schedule-style UTC labels name the UTC weekday and HHMM; fails_when=local time or a 12-hour clock leaks in; why_new=moved from ghostnet.test.ts (eng D3); seam=none; no_claim=none beyond protects
  it("labels UTC times", () => {
    expect(utcLabel(at("2026-11-27T01:00:00Z"))).toBe("Fri 0100 UTC");
    expect(utcWeekday(at("2026-11-27T01:00:00Z"))).toBe("Fri");
    expect(utcDate(at("2026-11-08T22:14:00Z"))).toBe("8 Nov");
    expect(utcDate(at("2025-11-08T22:14:00Z"), true)).toBe("8 Nov 2025");
  });

  // Value: protects=local times always carry the local weekday and short zone, which follows daylight saving, and the device zone is used when none is given; fails_when=the weekday or zone is dropped, the UTC day is shown as local, or the cached formatter ignores the device zone; why_new=moved from ghostnet.test.ts (D16, D17) plus the cached device formatter (eng D3); seam=timeZone argument and process.env.TZ; no_claim=every browser's zone names
  it("labels local times with weekday and zone, both sides of a DST change", () => {
    expect(localLabel(at("2026-11-27T01:00:00Z"), "America/Los_Angeles")).toBe("Thu 5:00 pm PST");
    expect(localLabel(at("2026-10-30T01:00:00Z"), "America/Los_Angeles")).toBe("Thu 6:00 pm PDT");
    expect(localLabel(at("2026-11-26T18:00:00Z"), "Europe/Berlin")).toMatch(/^Thu 7:00 pm (CET|GMT\+1)$/);
    expect(localLabel(at("2026-11-27T01:00:00Z"))).toBe("Thu 5:00 pm PST");
  });

  // Value: protects=the header clock is 24-hour UTC and its weekday and date flip together at UTC midnight, not local midnight; fails_when=a 12-hour or local field leaks in, or the date lags the time; why_new=#106 done-when; seam=process.env.TZ; no_claim=the ticking (UtcClock test)
  it.each([
    ["one second before UTC midnight", "2026-11-23T23:59:59Z", "Mon 23 Nov", "23:59:59"],
    ["UTC midnight", "2026-11-24T00:00:00Z", "Tue 24 Nov", "00:00:00"],
    ["UTC Tuesday while it's Monday evening in Los Angeles", "2026-11-24T01:30:05Z", "Tue 24 Nov", "01:30:05"],
    ["afternoon, 24-hour", "2026-11-23T14:05:09Z", "Mon 23 Nov", "14:05:09"],
  ])("clock: %s", (_name, iso, date, time) => {
    expect(utcClock(at(iso))).toEqual({ date, time });
  });

  // Value: protects=the tuning bar's clock is UTC HH:MM with no seconds; fails_when=seconds or local hours appear; why_new=design DD15; seam=none; no_claim=placement in the bar
  it("writes the short clock", () => {
    expect(utcClockShort(at("2026-11-24T01:30:59Z"))).toBe("01:30");
  });

  const now = at("2026-11-23T12:00:00Z"); // Monday

  // Value: protects=a stamp names a weekday only within 6 UTC days, a date after that, and a year once it's another year (design DD5/DD6); fails_when=the 6/7-day or New Year boundary slips, a save days ahead passes for this week, or "saved" is dropped; why_new=#107 stamp; seam=now passed in; no_claim=when the list re-renders
  it.each([
    ["today", "2026-11-23T03:10:00Z", "saved Mon 0310 UTC"],
    ["6 UTC days ago", "2026-11-17T23:59:00Z", "saved Tue 2359 UTC"],
    ["7 UTC days ago", "2026-11-16T23:59:00Z", "saved 16 Nov 2359 UTC"],
    ["weeks ago", "2026-11-08T22:14:00Z", "saved 8 Nov 2214 UTC"],
    ["last year", "2025-12-31T22:14:00Z", "saved 31 Dec 2025"],
    ["a little ahead of now (clock corrected since)", "2026-11-23T12:00:30Z", "saved Mon 1200 UTC"],
    [
      "hours ahead into tomorrow (a fast device clock, never measured)",
      "2026-11-24T03:00:00Z",
      "saved 24 Nov 0300 UTC",
    ],
    ["days ahead of now", "2026-11-26T22:14:00Z", "saved 26 Nov 2214 UTC"],
  ])("stamp: %s", (_name, iso, label) => {
    expect(savedLabel(at(iso), now)).toBe(label);
  });

  // Value: protects=a New Year's Day save is still "this week" on 2 Jan, not "last year"; fails_when=the year check runs before the 6-day check; why_new=#107 stamp; seam=now passed in; no_claim=none beyond protects
  it("keeps the weekday form across New Year within 6 days", () => {
    expect(savedLabel(at("2026-12-31T22:14:00Z"), at("2027-01-02T08:00:00Z"))).toBe("saved Thu 2214 UTC");
  });

  // Value: protects=the stamp's hover detail gives the full UTC date with year and the local time (design DD14); fails_when=the year or the local time is missing; why_new=#107 tooltip; seam=timeZone argument; no_claim=how browsers show titles
  it("gives the full date and local time for the stamp's title", () => {
    expect(savedTitle(at("2026-11-21T22:14:00Z"), "America/Los_Angeles")).toBe(
      "Saved Sat 21 Nov 2026, 2214 UTC · Sat 2:14 pm PST",
    );
  });
});
