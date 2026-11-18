import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Receiver } from "./kiwi-list";
import {
  MIN_NOISE_SAMPLES,
  NOISE_STEP_DB,
  noiseBand,
  noiseKey,
  rankByNoise,
  relativeNoiseDb,
  type NoiseLevels,
  type NoiseStat,
} from "./noise-rank";
import { noiseUrl, parseNoise } from "./use-noise";

function rx(name: string, over: Partial<Receiver> = {}): Receiver {
  return {
    id: name,
    name,
    location: "",
    antenna: "",
    host: `${name}.example`,
    port: 8073,
    users: 0,
    usersMax: 8,
    snr: 20,
    minKhz: 0,
    maxKhz: 30_000,
    ...over,
  };
}

const stat = (medianDb: number, count = MIN_NOISE_SAMPLES, baselineDb = 60): NoiseStat => ({
  medianDb,
  count,
  baselineDb,
  baselineCount: 50,
});

const levels = (band: string, by: Record<string, NoiseStat>): NoiseLevels => ({
  band,
  receivers: Object.fromEntries(Object.entries(by).map(([name, s]) => [`${name}.example:8073`, s])),
});

const names = (list: Receiver[]) => list.map((r) => r.name);

describe("noiseBand", () => {
  // Value: protects=the page asks the radio service about the band ids it keeps (bc-/ham- prefixed, broadcast first where they overlap); fails_when=an id drifts from noise.py's NOISE_BANDS, or 75m reads as 80m; why_new=issue #67; seam=none; no_claim=the service's own list (its test reads radio-types.ts)
  it("names the dial's bands as the radio service does", () => {
    expect(noiseBand(7_100)?.id).toBe("ham-40m");
    expect(noiseBand(7_300)?.id).toBe("bc-41m"); // 41m starts at 7200; broadcast wins the overlap
    expect(noiseBand(3_950)?.id).toBe("bc-75m"); // inside 80m too
    expect(noiseBand(18_950)?.id).toBe("bc-15m");
    expect(noiseBand(21_200)?.id).toBe("ham-15m");
    expect(noiseBand(10_000)).toBeNull();
  });

  it("matches the service's band list", () => {
    const py = readFileSync(new URL("../../../radio/skywave_radio/noise.py", import.meta.url), "utf8");
    for (const [khz, id] of [
      [2_400, "bc-120m"],
      [1_900, "ham-160m"],
      [28_500, "ham-10m"],
    ] as const) {
      expect(noiseBand(khz)?.id).toBe(id);
      expect(py).toContain(`("${id.split("-")[1]}",`);
    }
  });
});

describe("relativeNoiseDb", () => {
  it("is this band and hour against the receiver's own baseline, once there are enough samples", () => {
    expect(relativeNoiseDb(stat(52))).toBe(-8);
    expect(relativeNoiseDb(stat(52, MIN_NOISE_SAMPLES - 1))).toBeNull();
    expect(relativeNoiseDb({ ...stat(52), baselineDb: null })).toBeNull();
    expect(relativeNoiseDb(undefined)).toBeNull();
  });
});

describe("rankByNoise", () => {
  const a = rx("a", { snr: 30 });
  const b = rx("b", { snr: 25 });
  const c = rx("c", { snr: 20 });
  const d = rx("d", { snr: 15 });
  const ranked = [a, b, c, d];

  // Value: protects=measured receivers trade places by noise relative to their own baseline, unmeasured ones keep their SNR place; fails_when=absolute levels are compared across receivers, unmeasured ones are pushed down or up, or the order isn't the list's without data; why_new=issue #67; seam=none; no_claim=the measurements
  it("puts the quieter-than-usual receiver first among those measured, leaving the rest in SNR order", () => {
    // a: usual; c: 9 dB under its own baseline; b, d: not measured.
    const got = rankByNoise(ranked, levels("ham-40m", { a: stat(60), c: stat(51) }), 7_100);
    expect(names(got)).toEqual(["c", "b", "a", "d"]);
  });

  it("compares each receiver with itself, not absolute levels", () => {
    // a reads lower in absolute terms but is noisier than its usual; b is quieter than its usual.
    const got = rankByNoise(ranked, levels("ham-40m", { a: stat(45, 6, 40), b: stat(70, 6, 75) }), 7_100);
    expect(names(got)).toEqual(["b", "a", "c", "d"]);
  });

  it("falls back to the list's SNR below MIN_NOISE_SAMPLES", () => {
    const got = rankByNoise(ranked, levels("ham-40m", { c: stat(40, MIN_NOISE_SAMPLES - 1) }), 7_100);
    expect(names(got)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the list's order within one NOISE_STEP_DB step", () => {
    // -1 and -3 dB: both in the step from -NOISE_STEP_DB up to 0, so SNR decides.
    const same = rankByNoise(ranked, levels("ham-40m", { a: stat(59), b: stat(60 - NOISE_STEP_DB) }), 7_100);
    expect(names(same)).toEqual(["a", "b", "c", "d"]);
    // A step quieter moves up.
    const quieter = rankByNoise(ranked, levels("ham-40m", { a: stat(59), b: stat(60 - NOISE_STEP_DB - 1) }), 7_100);
    expect(names(quieter)).toEqual(["b", "a", "c", "d"]);
  });

  it("keeps full receivers last", () => {
    const full = rx("full", { users: 8, usersMax: 8, snr: 40 });
    const got = rankByNoise([a, b, full], levels("ham-40m", { a: stat(60), full: stat(30) }), 7_100);
    expect(names(got)).toEqual(["a", "b", "full"]);
  });

  it("ignores levels for another band or no band", () => {
    const quiet = levels("ham-20m", { d: stat(30) });
    expect(names(rankByNoise(ranked, quiet, 7_100))).toEqual(["a", "b", "c", "d"]);
    expect(names(rankByNoise(ranked, levels("ham-40m", { d: stat(30) }), 10_000))).toEqual(["a", "b", "c", "d"]);
    expect(names(rankByNoise(ranked, null, 7_100))).toEqual(["a", "b", "c", "d"]);
  });

  it("matches hosts case-insensitively, as the service keeps them", () => {
    const upper = rx("Q", { host: "Q.Example", snr: 1 });
    expect(noiseKey(upper)).toBe("q.example:8073");
    const got = rankByNoise(
      [a, upper],
      { band: "ham-40m", receivers: { "q.example:8073": stat(40), "a.example:8073": stat(60) } },
      7_100,
    );
    expect(names(got)).toEqual(["Q", "a"]);
  });
});

describe("noiseUrl", () => {
  it("points at the WebSocket's service over http(s)", () => {
    expect(noiseUrl("wss://radio.example/ws", ["a:8073", "b:8074"], "ham-40m")).toBe(
      "https://radio.example/noise?receivers=a%3A8073%2Cb%3A8074&band=ham-40m",
    );
    expect(noiseUrl("ws://localhost:8765/ws", ["a:8073"], "bc-31m")).toBe(
      "http://localhost:8765/noise?receivers=a%3A8073&band=bc-31m",
    );
    expect(noiseUrl("not a url", ["a:8073"], "bc-31m")).toBeNull();
  });
});

describe("parseNoise", () => {
  it("keeps well-formed rows and drops the rest", () => {
    expect(
      parseNoise({
        band: "ham-40m",
        hourUtc: 3,
        receivers: {
          "a:8073": { medianDb: 50, count: 6, baselineDb: 60, baselineCount: 20 },
          "b:8073": { medianDb: null, count: 0, baselineDb: 60, baselineCount: 20 },
          "c:8073": { medianDb: "50", count: 6, baselineDb: 60, baselineCount: 20 },
        },
      }),
    ).toEqual({
      band: "ham-40m",
      receivers: {
        "a:8073": { medianDb: 50, count: 6, baselineDb: 60, baselineCount: 20 },
        "b:8073": { medianDb: null, count: 0, baselineDb: 60, baselineCount: 20 },
      },
    });
    expect(parseNoise(null)).toBeNull();
    expect(parseNoise({ band: 3, receivers: {} })).toBeNull();
  });
});
