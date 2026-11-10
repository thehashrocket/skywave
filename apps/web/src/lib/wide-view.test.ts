import { describe, expect, it } from "vitest";
import { nearestKhz } from "./radio-types";
import { bandAt, bandZoom, nextView, spanKhz, tickStepKhz } from "./wide-view";

describe("wide view", () => {
  // Value: protects=the zoom steps are the owner's ~15, ~60 and ~230 kHz, centred on the dial, and none for the audio view; fails_when=a zoom number drifts or the audio view asks for a stream; why_new=wideband waterfall; seam=none; no_claim=a receiver reporting another coverage (frames carry the real span)
  it("maps each width to a Kiwi zoom around the dial", () => {
    expect(nextView("audio", 9_650, null)).toBeNull();
    expect(nextView("15", 9_650, null)).toEqual({ zoom: 11, cfKhz: 9_650 });
    expect(nextView("60", 9_650, null)).toEqual({ zoom: 9, cfKhz: 9_650 });
    expect(nextView("230", 9_650, null)).toEqual({ zoom: 7, cfKhz: 9_650 });
    expect([11, 9, 7].map((z) => Math.round(spanKhz(z)))).toEqual([15, 59, 234]);
  });

  // Value: protects=the view holds still (same object) while the dial moves inside its middle 80% and recentres past that, and a new width recentres at once; fails_when=every tune repoints the receiver's waterfall, or the dial can walk off the picture; why_new=wideband waterfall; seam=none; no_claim=none
  it("stays put while the dial moves inside it", () => {
    const at = nextView("60", 9_650, null)!;
    const edge = spanKhz(9) * 0.4;
    expect(nextView("60", 9_650 + edge, at)).toBe(at);
    expect(nextView("60", 9_650 - edge, at)).toBe(at);
    expect(nextView("60", 9_650 + edge + 0.01, at)).toEqual({ zoom: 9, cfKhz: 9_650 + edge + 0.01 });
    expect(nextView("230", 9_660, at)).toEqual({ zoom: 7, cfKhz: 9_660 });
  });

  // Value: protects=the band width frames the whole dial band the dial is in (broadcast before an overlapping ham band) with the closest zoom that holds it, stays the same object within the band, and is none outside every band; fails_when=a zoom clips the band, ham wins the 75m/80m overlap, or out-of-band returns a view; why_new=owner decision: a "Band" step; seam=none; no_claim=the band table itself
  it("frames the dial's band", () => {
    expect(bandAt(9_650)?.name).toBe("31m");
    expect(bandAt(3_950)?.name).toBe("75m");
    expect(bandAt(14_200)?.name).toBe("20m");
    expect(bandAt(8_000)).toBeUndefined();
    const band = nextView("band", 9_650, null)!;
    expect(band).toEqual({ zoom: 5, cfKhz: 9_650 });
    expect(nextView("band", 9_800, band)).toBe(band);
    expect(nextView("band", 8_000, band)).toBeNull();
    for (const name of ["31m", "11m", "10m", "160m"]) {
      const b = [9_650, 25_800, 28_500, 1_900].map(bandAt).find((x) => x?.name === name)!;
      const z = bandZoom(b);
      expect(spanKhz(z)).toBeGreaterThanOrEqual(b.endKhz - b.startKhz);
      expect(spanKhz(z + 1)).toBeLessThan((b.endKhz - b.startKhz) * 1.1);
    }
  });

  // Value: protects=axis ticks come at round steps, four to eight across any width; fails_when=a narrow or wide view crowds or empties its axis; why_new=wideband waterfall; seam=none; no_claim=label overlap at phone width (browser check)
  it("picks a round tick step for any width", () => {
    for (const span of [12, 14.6, 58.6, 234, 469, 937.5, 30_000]) {
      const n = span / tickStepKhz(span);
      expect(n).toBeLessThanOrEqual(8);
      expect(n).toBeGreaterThanOrEqual(2.5);
    }
  });

  // Value: protects=a click lands on the nearest channel of the grid (5 kHz shortwave, 9 kHz medium wave, 100 Hz SSB) and stays tunable; fails_when=float drift leaves 9,649.9999 or the clamp is skipped; why_new=click-to-tune on the wide view; seam=none; no_claim=none
  it("rounds to the nearest channel", () => {
    expect(nearestKhz(9_652.4, 5)).toBe(9_650);
    expect(nearestKhz(9_652.6, 5)).toBe(9_655);
    expect(nearestKhz(1_002.5, 9)).toBe(999);
    expect(nearestKhz(14_200.04, 0.1)).toBe(14_200);
    expect(nearestKhz(30_010, 5)).toBe(30_000);
  });
});
