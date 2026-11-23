import { describe, expect, it } from "vitest";
import {
  EVENTS,
  followingSlot,
  formatWait,
  GHOSTNET_LISTEN_LEAD_MS,
  inRegion,
  isTuned,
  onSlotFrequency,
  listenOffered,
  localLabel,
  msUntil,
  nextStart,
  nextWindow,
  rankForRegion,
  REGIONS,
  stripRows,
  utcLabel,
  utcSpan,
  windowsAt,
  type RegionId,
} from "./ghostnet";
import type { Receiver } from "./kiwi-list";

const at = (iso: string) => Date.parse(iso);
const MIN = 60_000;
const event = (id: string) => EVENTS.find((e) => e.id === id)!;
const onAir = (iso: string) =>
  windowsAt(at(iso)).map((o) => `${o.event.id}:${o.slot.kind}:${o.slot.dialKhz ?? "-"}:${o.slot.mode ?? "-"}`);

// 2026-11-26 is a Thursday, 2026-11-27 a Friday, 2026-11-28 a Saturday.
describe("windowsAt", () => {
  // Value: protects=the North America net runs Fri 0100-0300 UTC (Thursday evening in the Americas), slot by slot, with the RTTY dial below its 7.077 mark (D8) and voice in LSB; fails_when=the net is keyed to Thursday UTC, a slot offset or mode is wrong, or a boundary isn't half-open; why_new=new schedule (#91); seam=none; no_claim=whether the net runs that week
  it.each([
    ["2026-11-26T23:59:59Z", []],
    ["2026-11-27T00:59:59Z", []],
    ["2026-11-27T01:00:00Z", ["na:js8:7107:usb"]],
    ["2026-11-27T01:30:00Z", ["na:vara:7107:usb"]],
    ["2026-11-27T02:00:00Z", ["na:rtty:7074.875:usb"]],
    ["2026-11-27T02:30:00Z", ["na:voice:7190:lsb"]],
    ["2026-11-27T02:59:59Z", ["na:voice:7190:lsb"]],
    ["2026-11-27T03:00:00Z", []],
  ])("at %s", (iso, expected) => {
    expect(onAir(iso)).toEqual(expected);
  });

  // Value: protects=the Europe and Australia nets are on Thursday UTC at 1800 and 0700 (guide's section pages); fails_when=either is moved to Friday like the NA net or to the wrong hour; why_new=issue asked to confirm these days; seam=none; no_claim=the guide's p.12 grid shading
  it("puts the Europe net at Thu 1800 UTC and the Australia net at Thu 0700 UTC", () => {
    expect(onAir("2026-11-26T18:00:00Z")).toEqual(["eu:js8:7107:usb"]);
    expect(onAir("2026-11-26T07:00:00Z")).toEqual(["au:js8:7107:usb"]);
    expect(onAir("2026-11-26T08:59:00Z")).toEqual(["au:voice:7190:lsb"]);
  });

  // Value: protects=Saturday's bridges from 0800 to 2200, including the 2000 hand-over where NA-Europe ALE ends as Europe-Australia JS8 starts (exactly one on the air); fails_when=a bridge slot is wrong or both or neither show at a boundary; why_new=bridge windows; seam=none; no_claim=none beyond protects
  it.each([
    ["2026-11-28T07:59:59Z", []],
    ["2026-11-28T08:00:00Z", ["au-sp:js8:14107:usb"]],
    ["2026-11-28T09:00:00Z", ["au-sp:js8:7107:usb"]],
    ["2026-11-28T09:30:00Z", ["au-sp:ale:-:-"]],
    ["2026-11-28T12:00:00Z", ["na-au:js8:14107:usb"]],
    ["2026-11-28T13:00:00Z", ["na-au:ale:-:-"]],
    ["2026-11-28T13:30:00Z", ["na-au:js8:3575:usb"]],
    ["2026-11-28T18:00:00Z", ["na-eu:js8:14107:usb"]],
    ["2026-11-28T19:59:59Z", ["na-eu:ale:-:-"]],
    ["2026-11-28T20:00:00Z", ["eu-au:js8:14107:usb"]],
    ["2026-11-28T21:30:00Z", ["eu-au:js8:3575:usb"]],
    ["2026-11-28T22:00:00Z", []],
  ])("at %s", (iso, expected) => {
    expect(onAir(iso)).toEqual(expected);
  });
});

describe("nextStart, nextWindow, msUntil, followingSlot", () => {
  // Value: protects=after Saturday's last bridge the next opening is next week's Thursday 0700 Australia net, and a running event's next start is a week on; fails_when=the week wrap is off or a running event counts as opening now; why_new=week boundary; seam=none; no_claim=none beyond protects
  it("wraps into the next week", () => {
    const after = at("2026-11-28T22:00:00Z");
    const next = nextWindow(after);
    expect(next.event.id).toBe("au");
    expect(next.startMs).toBe(at("2026-12-03T07:00:00Z"));
    expect(msUntil(next, after)).toBe(next.startMs - after);
    expect(nextStart(event("na"), at("2026-11-27T01:10:00Z")).startMs).toBe(at("2026-12-04T01:00:00Z"));
  });

  // Value: protects=the "next slot" line under an on-air row names the event's following slot at the right time, and none after the last; fails_when=the following slot's absolute time is computed from the wrong base; why_new=on-now row (D13); seam=none; no_claim=none beyond protects
  it("finds the following slot in the same event", () => {
    const [js8] = windowsAt(at("2026-11-27T01:10:00Z"));
    const vara = followingSlot(js8!)!;
    expect(vara.slot.kind).toBe("vara");
    expect(vara.startMs).toBe(at("2026-11-27T01:30:00Z"));
    const [voice] = windowsAt(at("2026-11-27T02:40:00Z"));
    expect(followingSlot(voice!)).toBeNull();
  });
});

describe("stripRows", () => {
  // Value: protects=the strip shows the running event's slot on now and one Next row per other event at its opening, soonest first (D13); fails_when=a running event also appears in Next, or Next isn't sorted; why_new=row model; seam=none; no_claim=rendering
  it("splits on-now slots from next openings", () => {
    const { onNow, next } = stripRows(at("2026-11-27T01:10:00Z"));
    expect(onNow.map((o) => o.event.id)).toEqual(["na"]);
    expect(next.map((o) => o.event.id)).toEqual(["au-sp", "na-au", "na-eu", "eu-au", "au", "eu"]);
    expect(next.every((o) => o.index === 0)).toBe(true);
  });
});

describe("listenOffered", () => {
  // Value: protects=Listen appears only on a single-frequency window that is on now or opens within 15 minutes, never on ALE (D9); fails_when=the lead is off by a minute, ended windows keep Listen, or ALE gets one; why_new=Kiwi slot holding (D9); seam=none; no_claim=listener behavior
  it("offers Listen within the lead and while on, not for ALE", () => {
    const eu = nextStart(event("eu"), at("2026-11-26T00:00:00Z"));
    expect(listenOffered(eu, eu.startMs - GHOSTNET_LISTEN_LEAD_MS - MIN)).toBe(false);
    expect(listenOffered(eu, eu.startMs - GHOSTNET_LISTEN_LEAD_MS)).toBe(true);
    expect(listenOffered(eu, eu.startMs + MIN)).toBe(true);
    expect(listenOffered(eu, eu.endMs)).toBe(false);
    const [ale] = windowsAt(at("2026-11-28T19:10:00Z"));
    expect(listenOffered(ale!, at("2026-11-28T19:10:00Z"))).toBe(false);
  });
});

describe("isTuned", () => {
  const js8 = event("na").slots[0]!;
  // Value: protects=a row counts as tuned within 0.1 kHz in the same mode only (D12), so the note never claims a net the filter cuts off; fails_when=the tolerance widens, floating point drops the 0.1 edge, or mode is ignored; why_new=tuned rule; seam=none; no_claim=what the listener hears
  it.each([
    [7107, "usb", true],
    [7107.1, "usb", true],
    [7106.9, "usb", true],
    [7107.11, "usb", false],
    [7107, "lsb", false],
  ] as const)("dial %s %s → %s", (khz, mode, expected) => {
    expect(isTuned(js8, khz, mode)).toBe(expected);
  });
});

describe("inRegion", () => {
  const where = (lat: number, lon: number) =>
    (Object.keys(REGIONS) as RegionId[]).filter((id) => inRegion(REGIONS[id], lat, lon));
  // Value: protects=coast and island cities land in their net's region, the South Pacific box crosses 180°, and nearby places stay out (D16); fails_when=a box edge moves or the 180° wrap is wrong; why_new=region boxes replaced the 1,500 km centroid rule; seam=none; no_claim=reception quality
  it.each([
    ["New York", 40.7, -74, ["na"]],
    ["Los Angeles", 34.05, -118.2, ["na"]],
    ["Seattle", 47.6, -122.3, ["na"]],
    ["Miami", 25.8, -80.2, ["na"]],
    ["Anchorage", 61.2, -149.9, ["na"]],
    ["Toronto", 43.7, -79.4, ["na"]],
    ["London", 51.5, -0.1, ["eu"]],
    ["Lisbon", 38.7, -9.1, ["eu"]],
    ["Helsinki", 60.2, 24.9, ["eu"]],
    ["Athens", 38, 23.7, ["eu"]],
    ["Sydney", -33.9, 151.2, ["au"]],
    ["Perth", -31.95, 115.9, ["au"]],
    ["Brisbane", -27.5, 153, ["au"]],
    ["Hobart", -42.9, 147.3, ["au"]],
    ["Auckland", -36.8, 174.8, ["sp"]],
    ["Fiji", -18.1, 178.4, ["sp"]],
    ["Samoa", -13.8, -171.8, ["sp"]],
    ["Noumea", -22.3, 166.4, ["sp"]],
    ["Tahiti", -17.5, -149.6, ["sp"]],
    ["Mexico City", 19.4, -99.1, []],
    ["Honolulu", 21.3, -157.9, []],
    ["Reykjavik", 64.1, -21.9, []],
    ["Canaries", 28.1, -15.4, []],
    ["Jakarta", -6.2, 106.8, []],
    ["Port Moresby", -9.4, 147.2, []],
  ] as const)("%s", (_city, lat, lon, expected) => {
    expect(where(lat, lon)).toEqual(expected);
  });
});

function rx(host: string, lat: number | undefined, lon: number | undefined, over: Partial<Receiver> = {}): Receiver {
  return {
    id: host,
    name: host,
    location: "",
    antenna: "",
    host,
    port: 8073,
    users: 0,
    usersMax: 8,
    snr: 20,
    minKhz: 0,
    maxKhz: 30_000,
    ...(lat !== undefined && lon !== undefined && { lat, lon }),
    ...over,
  };
}

describe("rankForRegion", () => {
  const sydney = rx("sydney", -33.9, 151.2, { snr: 10 });
  const perth = rx("perth", -31.95, 115.9, { snr: 15 });
  const tokyo = rx("tokyo", 35.7, 139.7, { snr: 40 });
  const auckland = rx("auckland", -36.8, 174.8, { snr: 5 });
  const fullBrisbane = rx("brisbane", -27.5, 153, { snr: 30, users: 8 });
  const nowhere = rx("nowhere", undefined, undefined, { snr: 50 });
  const noHf = rx("vlf", -33.9, 151.2, { maxKhz: 1_000 });
  const hosts = (list: Receiver[]) => list.map((r) => r.host);

  // Value: protects=receivers inside the net's region come before stronger ones outside it, full ones stay last (D18) and unplaced ones after placed ones, then SNR; ones that can't tune the frequency are left out; fails_when=SNR outranks region, full-last or covers is dropped; why_new=region ranking; seam=none; no_claim=reception quality
  it("puts in-region receivers first, full last", () => {
    expect(hosts(rankForRegion([tokyo, nowhere, sydney, fullBrisbane, perth, noHf], ["au"], 7107))).toEqual([
      "perth",
      "sydney",
      "tokyo",
      "nowhere",
      "brisbane",
    ]);
  });

  // Value: protects=a bridge counts receivers at either end as in region; fails_when=only the first region is checked; why_new=bridges (issue #91); seam=none; no_claim=none beyond protects
  it("takes either end of a bridge", () => {
    expect(hosts(rankForRegion([tokyo, auckland, sydney], ["au", "sp"], 14107))).toEqual(["sydney", "auckland", "tokyo"]);
  });
});

describe("formatting", () => {
  // Value: protects=waits read "2d 16h", "4h 12m", m:ss under an hour, or whole minutes for the folded summary (D6); fails_when=a unit boundary is off or seconds show in the summary; why_new=GhostNet waits run to days; seam=none; no_claim=none beyond protects
  it.each([
    [2 * 86_400_000 + 16 * 3_600_000 + 5 * MIN, true, "2d 16h"],
    [4 * 3_600_000 + 12 * MIN + 30_000, true, "4h 12m"],
    [12 * MIN + 40_000, true, "12:40"],
    [12 * MIN + 40_000, false, "13 min"],
    [0, false, "1 min"],
  ] as const)("%i ms (seconds %s) → %s", (ms, seconds, expected) => {
    expect(formatWait(ms, seconds)).toBe(expected);
  });

  // Value: protects=UTC labels name the UTC weekday and a slot's span; fails_when=local time or a 12-hour clock leaks into the UTC label; why_new=new labels; seam=none; no_claim=none beyond protects
  it("labels UTC times", () => {
    expect(utcLabel(at("2026-11-27T01:00:00Z"))).toBe("Fri 0100 UTC");
    const [js8] = windowsAt(at("2026-11-27T01:10:00Z"));
    expect(utcSpan(js8!)).toBe("0100–0130 UTC");
  });

  // Value: protects=local times always carry the local weekday (Fri 0100 UTC is Thu evening in Los Angeles, D16) and the device's short zone name, which follows daylight saving (PDT before 1 Nov 2026, PST after, D17); fails_when=the weekday or zone is dropped or the UTC day is shown as local; why_new=local time column; seam=timeZone argument (Intl); no_claim=every browser's zone names
  it("labels local times with weekday and zone, both sides of a DST change", () => {
    expect(localLabel(at("2026-11-27T01:00:00Z"), "America/Los_Angeles")).toBe("Thu 5:00 pm PST");
    expect(localLabel(at("2026-10-30T01:00:00Z"), "America/Los_Angeles")).toBe("Thu 6:00 pm PDT");
    expect(localLabel(at("2026-11-26T18:00:00Z"), "Europe/Berlin")).toMatch(/^Thu 7:00 pm (CET|GMT\+1)$/);
  });
  // Value: protects=a GhostNet pick follows its net while the dial is on any of its frequencies, whatever the mode, within 0.1 kHz, and not on a nearby frequency or a null (ALE) dial (owner D11); fails_when=the check compares mode or uses the wrong tolerance; why_new=pick lifetime follows the net; seam=none; no_claim=page wiring (page tests)
  it("onSlotFrequency matches the slot's dial in any mode", () => {
    const voice = EVENTS.find((e) => e.id === "na")!.slots.find((sl) => sl.kind === "voice")!;
    expect(onSlotFrequency(voice, 7190)).toBe(true);
    expect(onSlotFrequency(voice, 7190.1)).toBe(true);
    expect(onSlotFrequency(voice, 7190.2)).toBe(false);
    const ale = EVENTS.flatMap((e) => e.slots).find((sl) => sl.kind === "ale")!;
    expect(onSlotFrequency(ale, 7107)).toBe(false);
  });
});
