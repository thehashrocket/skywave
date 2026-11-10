import { describe, expect, it } from "vitest";
import { guessMode, inAmericas, stepKhz, tuningStepKhz } from "./radio-types";

describe("guessMode", () => {
  it.each([
    [6_999, "am"], // just below 40 m
    [7_000, "lsb"], // 40 m lower edge
    [7_300, "lsb"], // 40 m upper edge
    [7_301, "am"], // 41 m broadcast
    [3_900, "lsb"], // 75 m phone
    [9_999, "am"], // just below 10 MHz, not a ham band
    [10_100, "usb"], // 30 m: ham, at or above 10 MHz
    [14_250, "usb"], // 20 m phone
    [10_000, "am"], // WWV
  ] as const)("%d kHz → %s", (khz, mode) => {
    expect(guessMode(khz)).toBe(mode);
  });
});

describe("tuningStepKhz", () => {
  // Value: protects=one wheel notch is an AM channel (10 kHz medium wave in the Americas, 9 elsewhere and on long wave, 5 on shortwave), 100 Hz for SSB and 10 Hz for CW; fails_when=a band edge, the region switch or a mode's step is wrong; why_new=wheel tuning; seam=none; no_claim=what any one country uses
  it.each([
    [1_000, "am", true, 10],
    [1_000, "am", false, 9],
    [1_710, "am", true, 10], // medium wave's top edge
    [1_711, "am", true, 5], // shortwave (well, 160 m and up)
    [198, "am", true, 9], // long wave is 9 even in the Americas
    [9_580, "am", false, 5],
    [14_200, "usb", true, 0.1],
    [7_100, "lsb", false, 0.1],
    [7_030, "cw", false, 0.01],
  ] as const)("%s kHz %s (Americas %s) steps %s kHz", (freq, mode, americas, step) => {
    expect(tuningStepKhz(freq, mode, americas)).toBe(step);
  });

  // Value: protects=the Americas test covers the continent and leaves Europe, Africa and the Pacific out; fails_when=the longitude range is inverted or too wide; why_new=wheel tuning; seam=none; no_claim=exact ITU region borders
  it("knows the Americas by longitude", () => {
    expect(inAmericas(-72.6)).toBe(true); // Vermont
    expect(inAmericas(-58.4)).toBe(true); // Buenos Aires
    expect(inAmericas(0.7)).toBe(false); // Tremolat
    expect(inAmericas(151.2)).toBe(false); // Sydney
  });
});

describe("stepKhz", () => {
  // Value: protects=a step from a channel lands on the next channel, a step from between channels lands on the nearest one that way, sub-kHz steps don't drift, and the result stays in range; fails_when=snapping is skipped or float arithmetic leaks (7030.009999); why_new=wheel tuning; seam=none; no_claim=none beyond protects
  it.each([
    [9_580, 5, 1, 9_585],
    [9_583, 5, 1, 9_585],
    [9_583, 5, -1, 9_580],
    [1_008, 9, 1, 1_017],
    [1_010, 9, -1, 1_008],
    [14_200.05, 0.1, 1, 14_200.1],
    [7_030, 0.01, -1, 7_029.99],
    [29_998, 5, 1, 30_000],
    [30_000, 5, 1, 30_000],
    [10, 9, -1, 10],
  ] as const)("%s by %s in direction %s is %s", (from, step, dir, to) => {
    expect(stepKhz(from, step, dir)).toBe(to);
  });
});
