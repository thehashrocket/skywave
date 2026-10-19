import { describe, expect, it } from "vitest";
import { sUnits } from "./SMeter";

describe("sUnits", () => {
  it.each([
    [-140, "S0"],
    [-127, "S0"],
    [-121, "S1"],
    [-79, "S8"],
    [-73, "S9"],
    [-70, "S9"], // under 5 dB over rounds down
    [-63, "S9+10"],
    [-53, "S9+20"],
    [-33, "S9+40"],
  ])("%d dBm → %s", (dbm, s) => {
    expect(sUnits(dbm)).toBe(s);
  });
});
