import { describe, expect, it } from "vitest";
import { guessMode } from "./radio-types";

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
