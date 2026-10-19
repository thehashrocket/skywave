import { describe, expect, it } from "vitest";
import { parseFrequencyKhz } from "./FrequencyReadout";

describe("parseFrequencyKhz", () => {
  it.each([
    ["9,535.00", 9535],
    ["7030.5", 7030.5],
    ["10 000 kHz", 10000],
    ["12.345", 12.35], // rounded to 10 Hz
    ["30000", 30000],
    ["30000.01", null],
    ["0", null],
    ["", null],
    ["abc", null],
    ["1.2.3", null],
  ])("%j → %s", (text, khz) => {
    expect(parseFrequencyKhz(text)).toBe(khz);
  });
});
