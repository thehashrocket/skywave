import { describe, expect, it } from "vitest";
import { beaconFit, DAYLIGHT_KHZ, MAX_BEACON_KM, MIN_BEACON_KM, rankForBeacon } from "./beacon-rank";
import { findBeacon } from "./ibp";
import type { Receiver } from "./kiwi-list";
import type { SunPosition } from "./solar";

const TEL_AVIV = findBeacon("4X6TU")!;
const KHZ = 21_150;

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

// About 90 km from the beacon: inside the skip zone.
const haifa = rx("haifa", 32.8, 35.0, { snr: 40 });
// About 3,600 km: one or two hops.
const london = rx("london", 51.5, -0.12, { snr: 10 });
// About 2,100 km the other way.
const tehran = rx("tehran", 35.7, 51.4, { snr: 10 });
// About 14,000 km: too far.
const sydney = rx("sydney", -33.9, 151.2, { snr: 40 });

/** The sun overhead at the equator, at this longitude. */
const sunOver = (lon: number): SunPosition => ({ declination: 0, subsolarLon: lon });
// Midday over Europe and the Middle East: every path from Tel Aviv above is lit in the middle.
const NOON_EUROPE = sunOver(20);
const hosts = (list: Receiver[]) => list.map((r) => r.host);

describe("beaconFit", () => {
  // Value: protects=distance and the 1,000–8,000 km window are measured from the beacon, with how far outside it a receiver sits; fails_when=the bounds or the measure are wrong; why_new=beacon ranking; seam=none; no_claim=propagation
  it("measures each receiver against the distance window", () => {
    expect(beaconFit(haifa, TEL_AVIV, KHZ, NOON_EUROPE)).toMatchObject({ inRange: false });
    expect(beaconFit(haifa, TEL_AVIV, KHZ, NOON_EUROPE).kmOutside).toBeGreaterThan(MIN_BEACON_KM - 150);
    expect(beaconFit(london, TEL_AVIV, KHZ, NOON_EUROPE)).toMatchObject({ inRange: true, kmOutside: 0 });
    expect(beaconFit(sydney, TEL_AVIV, KHZ, NOON_EUROPE).distanceKm).toBeGreaterThan(MAX_BEACON_KM);
    expect(beaconFit(rx("nowhere", undefined, undefined), TEL_AVIV, KHZ, NOON_EUROPE)).toEqual({
      distanceKm: null,
      inRange: false,
      kmOutside: Infinity,
      sunlit: false,
    });
  });

  // Value: protects=daylight is judged at the path's midpoint, and only from 14 MHz up; fails_when=it's judged at the receiver or beacon, or applied below 14 MHz; why_new=beacon ranking; seam=hand-made sun position; no_claim=real ionospheric conditions
  it("checks daylight at the midpoint, from 14 MHz up", () => {
    expect(beaconFit(london, TEL_AVIV, KHZ, NOON_EUROPE).sunlit).toBe(true);
    expect(beaconFit(london, TEL_AVIV, KHZ, sunOver(-160)).sunlit).toBe(false);
    expect(beaconFit(london, TEL_AVIV, DAYLIGHT_KHZ - 1, sunOver(-160)).sunlit).toBe(true);
  });
});

describe("rankForBeacon", () => {
  // Value: protects=a well-placed receiver (in the window, lit midpoint) beats a stronger one in the skip zone or too far away, so distance from the beacon outranks raw SNR; fails_when=SNR or nearness wins; why_new=beacon ranking (issue #59: "not the closest"); seam=none; no_claim=propagation
  it("prefers a receiver 1,000–8,000 km from the beacon over a closer or stronger one", () => {
    expect(hosts(rankForBeacon([haifa, sydney, london], TEL_AVIV, KHZ, NOON_EUROPE))[0]).toBe("london");
  });

  // Value: protects=a lit midpoint wins between two receivers in the window, and both tests together beat either alone; fails_when=daylight is ignored, or one test outweighs both; why_new=beacon ranking; seam=hand-made sun position; no_claim=propagation
  it("prefers a sunlit path, and meeting both tests over either", () => {
    // Late afternoon in the Middle East (sun over Borneo, 9° south): the Tel Aviv–Tehran midpoint is
    // still lit, Tel Aviv–London's (over the Adriatic) has set.
    const eastern: SunPosition = { declination: -9, subsolarLon: 115 };
    expect(beaconFit(tehran, TEL_AVIV, KHZ, eastern).sunlit).toBe(true);
    expect(beaconFit(london, TEL_AVIV, KHZ, eastern).sunlit).toBe(false);
    expect(hosts(rankForBeacon([london, tehran], TEL_AVIV, KHZ, eastern))).toEqual(["tehran", "london"]);
    // Haifa's midpoint is lit too, but it's in the skip zone: London (one test) ties it on tests, and wins on distance.
    expect(hosts(rankForBeacon([haifa, london, tehran], TEL_AVIV, KHZ, eastern))).toEqual([
      "tehran",
      "london",
      "haifa",
    ]);
  });

  // Value: protects=only receivers that tune the band are offered, full ones go last (not away), and ones with no position come after every located one; fails_when=an uncovered receiver is tried, a full one is first, or an unplaced one outranks a placed one; why_new=beacon ranking (covers/isFull, as rankReceivers); seam=none; no_claim=none
  it("keeps to receivers that tune the band, full and unplaced ones last", () => {
    const full = rx("full", 51.5, -0.1, { users: 8 });
    const narrow = rx("narrow", 51.6, -0.1, { maxKhz: 20_000 });
    const unplaced = rx("unplaced", undefined, undefined, { snr: 50 });
    expect(hosts(rankForBeacon([full, unplaced, narrow, haifa, london], TEL_AVIV, KHZ, NOON_EUROPE))).toEqual([
      "london",
      "haifa",
      "unplaced",
      "full",
    ]);
  });

  // Value: protects=among receivers meeting the same tests, in-window ones go by listed SNR (byRank), out-of-window ones by how near the window they are; fails_when=ties ignore SNR, or out-of-window ones are ordered by SNR over distance; why_new=beacon ranking; seam=none; no_claim=none
  it("breaks ties by SNR inside the window, by nearness outside it", () => {
    const strongLondon = rx("strong-london", 51.4, -0.2, { snr: 30 });
    expect(hosts(rankForBeacon([london, strongLondon], TEL_AVIV, KHZ, NOON_EUROPE))).toEqual([
      "strong-london",
      "london",
    ]);
    // Night on both paths, and both inside the skip zone: neither meets a test, so the one nearer the window wins.
    const dark = sunOver(-160);
    const nearer = rx("cyprus", 34.9, 33.6, { snr: 5 }); // ~340 km
    expect(hosts(rankForBeacon([haifa, nearer], TEL_AVIV, KHZ, dark))).toEqual(["cyprus", "haifa"]);
  });
});
