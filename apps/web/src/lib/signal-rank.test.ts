import { describe, expect, it } from "vitest";
import type { Receiver } from "./kiwi-list";
import { noiseBand, noiseKey, type NoiseLevels } from "./noise-rank";
import { rankForSignal, signalFit } from "./signal-rank";
import type { Transmitter } from "./signal-stations";
import type { SunPosition } from "./solar";

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

const NARO_FOMINSK: Transmitter = { lat: 55.38, lon: 36.73, label: "Naro-Fominsk", confidence: "known" };
const MOSCOW_COUNTRY: Transmitter = { lat: 55.75, lon: 37.62, label: "Russia", confidence: "country" };

/** The sun overhead at the equator, at this longitude. */
const sunOver = (lon: number): SunPosition => ({ declination: 0, subsolarLon: lon });
// Noon over Japan: a path from Moscow west to London is dark at its midpoint,
// one east to Novosibirsk still lit (late afternoon over western Siberia).
const NOON_JAPAN = sunOver(140);
const hosts = (list: Receiver[]) => list.map((r) => r.host);

// Both roughly 2,500-2,900 km from the transmitter: one or two hops.
const london = rx("london", 51.5, -0.12, { snr: 10 });
const novosibirsk = rx("novosibirsk", 55.0, 82.9, { snr: 40 });

describe("rankForSignal", () => {
  // Value: protects=on 4625 kHz (UVB-76) a receiver whose path midpoint is dark ranks above one at a similar distance whose path is sunlit, even with a lower listed SNR (#99 acceptance); fails_when=the light rule is the beacons' (daylight) below 8 MHz, or SNR outranks the path; why_new=#99 signal ranking; seam=hand-made sun position; no_claim=real ionospheric conditions
  it("prefers a dark path below 8 MHz", () => {
    expect(signalFit(london, NARO_FOMINSK, 4_625, NOON_JAPAN)).toMatchObject({ inRange: true, lightOk: true });
    expect(signalFit(novosibirsk, NARO_FOMINSK, 4_625, NOON_JAPAN)).toMatchObject({ inRange: true, lightOk: false });
    expect(hosts(rankForSignal([novosibirsk, london], NARO_FOMINSK, 4_625, NOON_JAPAN))).toEqual(["london", "novosibirsk"]);
  });

  // Value: protects=at and above 10 MHz the same two receivers swap: the sunlit path wins, as for the beacons (#99 acceptance: day preference on a 14 MHz time signal); fails_when=the darkness rule is applied at every frequency; why_new=#99 signal ranking; seam=hand-made sun position; no_claim=real ionospheric conditions
  it("prefers a sunlit path from 10 MHz up", () => {
    expect(hosts(rankForSignal([london, novosibirsk], NARO_FOMINSK, 14_996, NOON_JAPAN))).toEqual(["novosibirsk", "london"]);
  });

  // Value: protects=close in (about 70 km) counts as in range on the low bands, where signals come down almost straight (NVIS), but is in the skip zone from 10 MHz up; fails_when=the beacons' 1,000 km floor is applied on 3-5 MHz, or dropped on the high bands; why_new=#99 signal ranking; seam=none; no_claim=propagation
  it("counts close-in receivers on the low bands only", () => {
    const moscow = rx("moscow", 55.75, 37.62);
    expect(signalFit(moscow, NARO_FOMINSK, 4_625, NOON_JAPAN).inRange).toBe(true);
    expect(signalFit(moscow, NARO_FOMINSK, 14_996, NOON_JAPAN).inRange).toBe(false);
  });

  // Value: protects=a country-level transmitter position doesn't over-reward distance: a receiver about 8,450 km away (Singapore) counts as in range with the country's slack, and in-range receivers aren't ordered by closeness, so the listed SNR decides; with a known position the same receiver is out of range and goes after the closer one (#99 acceptance); fails_when=a guessed position is trusted to the kilometre; why_new=#99 signal ranking; seam=none; no_claim=where the station really is
  it("weights distance less for a country-level position", () => {
    const berlin = rx("berlin", 52.5, 13.4, { snr: 10 });
    const singapore = rx("singapore", 1.35, 103.8, { snr: 40 });
    const known = { ...MOSCOW_COUNTRY, confidence: "known" as const };
    // 9 MHz: between the dark and sunlit rules, so only distance differs.
    expect(hosts(rankForSignal([singapore, berlin], known, 9_000, NOON_JAPAN))).toEqual(["berlin", "singapore"]);
    expect(hosts(rankForSignal([berlin, singapore], MOSCOW_COUNTRY, 9_000, NOON_JAPAN))).toEqual(["singapore", "berlin"]);
  });

  // Value: protects=only receivers that tune the frequency are offered, full ones go last rather than away, and unplaced ones follow placed ones (#99 acceptance: full receivers dropped to the end, as Pick best expects); fails_when=a receiver that can't tune the frequency is offered, or a full or unplaced one ranks first; why_new=#99 signal ranking; seam=none; no_claim=none
  it("keeps receivers that tune it, full and unplaced ones last", () => {
    const full = rx("full", 51.5, -0.12, { users: 8, snr: 50 });
    const unplaced = rx("unplaced", undefined, undefined, { snr: 50 });
    const vhfOnly = rx("vhf", 51.5, -0.12, { minKhz: 25_000 });
    expect(hosts(rankForSignal([full, unplaced, vhfOnly, london], NARO_FOMINSK, 4_625, NOON_JAPAN))).toEqual([
      "london",
      "unplaced",
      "full",
    ]);
  });

  // Value: protects=noise breaks ties between receivers with the same path fit (the quieter one first, against SNR; 3756 kHz, The Pip's night channel, is in the 80 m band the radio service measures) but never lifts a receiver past a better path; fails_when=noise is applied after the path order (rankByNoise style) or ignored; why_new=#99 ("blend in noise-rank"); seam=NoiseLevels shape; no_claim=noise measurement accuracy
  it("uses noise only to break ties", () => {
    const paris = rx("paris", 48.85, 2.35, { snr: 40 });
    const band = noiseBand(3_756)!.id;
    const stat = (medianDb: number) => ({ medianDb, count: 10, baselineDb: 0, baselineCount: 100 });
    const levels: NoiseLevels = {
      band,
      receivers: { [noiseKey(london)]: stat(-9), [noiseKey(paris)]: stat(6), [noiseKey(novosibirsk)]: stat(-30) },
    };
    expect(hosts(rankForSignal([paris, novosibirsk, london], NARO_FOMINSK, 3_756, NOON_JAPAN, levels))).toEqual([
      "london",
      "paris",
      "novosibirsk",
    ]);
    // Without noise, SNR decides between the two dark paths.
    expect(hosts(rankForSignal([london, paris], NARO_FOMINSK, 3_756, NOON_JAPAN))).toEqual(["paris", "london"]);
  });

  // Value: protects=an "approx" transmitter position gets 300 km of slack: a receiver about 150 km past 8,000 km counts as in range for an approximate site but not for a known one; fails_when=SLACK_KM.approx drops to 0 or the slack isn't applied; why_new=#99 review (slack untested); seam=none; no_claim=how far off an approximate site is
  it("stretches the range a little for an approximate position", () => {
    const tx: Transmitter = { lat: 0, lon: 0, label: "test", confidence: "approx" };
    // 8,150 km due east along the equator.
    const far = rx("far", 0, 8_150 / 111.195);
    expect(signalFit(far, tx, 9_000, NOON_JAPAN).inRange).toBe(true);
    expect(signalFit(far, { ...tx, confidence: "known" }, 9_000, NOON_JAPAN).inRange).toBe(false);
  });

  // Value: protects=noise levels measured for another band than the station's frequency are ignored, so SNR decides; fails_when=the band check is dropped and a stale band's noise reorders the list; why_new=#99 review (band guard untested); seam=NoiseLevels shape; no_claim=none
  it("ignores noise levels for another band", () => {
    const paris = rx("paris", 48.85, 2.35, { snr: 40 });
    const stat = { medianDb: -9, count: 10, baselineDb: 0, baselineCount: 100 };
    const levels: NoiseLevels = { band: noiseBand(14_100)!.id, receivers: { [noiseKey(london)]: stat } };
    expect(hosts(rankForSignal([london, paris], NARO_FOMINSK, 3_756, NOON_JAPAN, levels))).toEqual(["paris", "london"]);
  });

  // Value: protects=by day below 8 MHz a receiver within 800 km of the transmitter passes the light test (NVIS), so a nearby receiver isn't beaten by a distant one just because the distant path's midpoint is dark (owner, #99 review: near counts as fine); fails_when=the dark-midpoint rule applies close in, and a daytime UVB-76 Listen goes to North America; why_new=#99 review (daytime UVB-76); seam=hand-made sun position; no_claim=real ionospheric conditions
  it("counts a nearby receiver as fine by day below 8 MHz", () => {
    // Noon over Southeast Asia: Moscow is sunlit, the path to New York is dark at its midpoint.
    const sun = sunOver(100);
    const moscow = rx("moscow", 55.75, 37.62, { snr: 30 });
    const newYork = rx("newyork", 40.7, -74, { snr: 10 });
    expect(signalFit(moscow, NARO_FOMINSK, 4_625, sun)).toMatchObject({ inRange: true, lightOk: true });
    expect(signalFit(newYork, NARO_FOMINSK, 4_625, sun)).toMatchObject({ inRange: true, lightOk: true });
    expect(hosts(rankForSignal([newYork, moscow], NARO_FOMINSK, 4_625, sun))).toEqual(["moscow", "newyork"]);
  });
});
