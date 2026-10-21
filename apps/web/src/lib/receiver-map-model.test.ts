import { describe, expect, it } from "vitest";
import type { Receiver } from "./kiwi-list";
import {
  cameraTarget,
  changedStates,
  dotStates,
  hitGroup,
  markFeatures,
  receiverFeatures,
  shortName,
} from "./receiver-map-model";

function rx(host: string, over: Partial<Receiver> = {}): Receiver {
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
    lat: 10,
    lon: 20,
    ...over,
  };
}

// Noon UTC at the March equinox: the sun is over (0°, 0°), so 180° is midnight.
const sun = { declination: 0, subsolarLon: 0 };

describe("receiverFeatures", () => {
  // Value: protects=every receiver with a position gets a dot keyed by host:port, and the rest stay table-only; fails_when=receivers without GPS are drawn at (0,0) or the id isn't receiverKey; why_new=receiver map (T3); seam=none; no_claim=MapLibre's handling of promoteId
  it("draws receivers with a position, keyed by host:port", () => {
    const { features } = receiverFeatures([
      rx("a.example", { lat: 51.5, lon: -0.1, users: 8 }),
      rx("b.example", { lat: undefined, lon: undefined }),
    ]);
    expect(features).toEqual([
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-0.1, 51.5] },
        properties: { key: "a.example:8073", full: true },
      },
    ]);
  });
});

describe("dotStates", () => {
  // Value: protects=night, out-of-range, full, playing and last marks come from the right inputs; fails_when=a flag reads the wrong field, the playing receiver is also marked last, or no clock means everything is night; why_new=receiver map encoding (DT3/DT4); seam=none; no_claim=how the style draws them
  it("marks each dot from the sun, the dial, the load and what's playing", () => {
    const list = [
      rx("night.example", { lat: 0, lon: 180 }),
      rx("day.example", { lat: 0, lon: 0, users: 8 }),
      rx("mw.example", { lat: 0, lon: 0, minKhz: 10_500 }),
      rx("back.example", { lat: 0, lon: 0 }),
    ];
    const states = dotStates(list, {
      sun,
      freqKhz: 9_535,
      playing: { host: "night.example", port: 8073, phase: "connecting" },
      last: { host: "back.example", port: 8073 },
    });
    expect(Object.fromEntries(states)).toEqual({
      "night.example:8073": { night: true, outOfRange: false, full: false, phase: "connecting", last: false },
      "day.example:8073": { night: false, outOfRange: false, full: true, phase: null, last: false },
      "mw.example:8073": { night: false, outOfRange: true, full: false, phase: null, last: false },
      "back.example:8073": { night: false, outOfRange: false, full: false, phase: null, last: true },
    });
    // Before the page's clock starts, nothing is marked night.
    expect(
      dotStates(list, { sun: null, freqKhz: 9_535, playing: null, last: null }).get("night.example:8073")!.night,
    ).toBe(false);
  });

  it("never marks the receiver playing as the last one", () => {
    const states = dotStates([rx("a.example")], {
      sun,
      freqKhz: 9_535,
      playing: { host: "a.example", port: 8073, phase: "listening" },
      last: { host: "a.example", port: 8073 },
    });
    expect(states.get("a.example:8073")).toMatchObject({ phase: "listening", last: false });
  });
});

describe("changedStates", () => {
  const input = { sun, freqKhz: 9_535, playing: null, last: null };
  const list = [rx("a.example", { lat: 0, lon: 0 }), rx("b.example", { lat: 0, lon: 0, minKhz: 7_000 })];

  // Value: protects=after a list refresh (which drops MapLibre's feature state) every dot is re-styled; fails_when=a new list is diffed against the old states and unchanged dots lose their night/out-of-range look; why_new=R3; seam=none; no_claim=MapLibre's setData behaviour itself
  it("returns every state when nothing was applied yet", () => {
    expect(changedStates(null, dotStates(list, input)).map(([k]) => k)).toEqual(["a.example:8073", "b.example:8073"]);
  });

  // Value: protects=a dial move or minute tick touches only the dots that change; fails_when=the diff returns all dots or misses a changed field; why_new=receiver map performance (one update per frame on dial drags); seam=none; no_claim=frame timing
  it("returns only the dots whose look changes", () => {
    const before = dotStates(list, input);
    const after = dotStates(list, { ...input, freqKhz: 6_000 });
    expect(changedStates(before, after)).toEqual([
      ["b.example:8073", { night: false, outOfRange: true, full: false, phase: null, last: false }],
    ]);
    expect(changedStates(after, dotStates(list, { ...input, freqKhz: 6_000 }))).toEqual([]);
  });
});

describe("hitGroup", () => {
  const dots = [
    { key: "far:8073", x: 30, y: 0 },
    { key: "b:8074", x: 2, y: 0 },
    { key: "a:8073", x: 0, y: 0 },
  ];

  // Value: protects=a click on a multi-port site lists every receiver there, nearest first; fails_when=only the top feature is returned or the radius is ignored; why_new=no clustering, overlapping dots (design D4/T3); seam=none; no_claim=how MapLibre projects points
  it("lists every dot within the radius, nearest first", () => {
    expect(hitGroup(dots, { x: 0, y: 0 }, 10)).toEqual({ keys: ["a:8073", "b:8074"], more: false });
    expect(hitGroup(dots, { x: 0, y: 0 }, 22).keys).toEqual(["a:8073", "b:8074"]);
    expect(hitGroup(dots, { x: 100, y: 100 }, 22)).toEqual({ keys: [], more: false });
  });

  // Value: protects=a crowded spot shows at most 10 and says there are more; fails_when=the card lists hundreds of rows in central Europe at world zoom; why_new=design decision 13; seam=none; no_claim=the zoom-in action
  it("stops at the limit and says there are more", () => {
    const crowd = Array.from({ length: 12 }, (_, i) => ({ key: `r${i}:8073`, x: i, y: 0 }));
    const { keys, more } = hitGroup(crowd, { x: 0, y: 0 }, 22);
    expect(keys).toHaveLength(10);
    expect(keys[0]).toBe("r0:8073");
    expect(more).toBe(true);
  });
});

describe("cameraTarget", () => {
  const list = [rx("a.example", { lat: 51.5, lon: -0.1 }), rx("typed.example", { lat: undefined, lon: undefined })];

  // Value: protects=the map follows the receiver playing, stays put once you move it, and never chases one without a position; fails_when=follow ignores the user's pan, or a typed host with no GPS sends the camera to (0,0); why_new=design D8 (stay put until Center) and the "no location" state; seam=none; no_claim=easing
  const on = (host: string, phase: "connecting" | "listening" = "listening") => ({ host, port: 8073, phase });

  it("goes to the playing receiver only while following", () => {
    expect(cameraTarget("follow", on("a.example"), list)).toEqual([-0.1, 51.5]);
    expect(cameraTarget("stay", on("a.example"), list)).toBeNull();
    expect(cameraTarget("follow", null, list)).toBeNull();
    expect(cameraTarget("follow", on("typed.example"), list)).toBeNull();
    expect(cameraTarget("follow", on("unlisted.example"), list)).toBeNull();
  });

  // Value: protects=a switch that's still connecting (and may fail) doesn't drag the view away; fails_when=the camera follows a connecting receiver; why_new=browser QA (PR 2b): the map panned to a receiver that then refused; seam=none; no_claim=easing
  it("waits until the receiver is listening", () => {
    expect(cameraTarget("follow", on("a.example", "connecting"), list)).toBeNull();
  });
});

describe("markFeatures", () => {
  const list = [
    rx("a.example", { name: "A very long receiver name that goes on and on", lat: 1, lon: 2 }),
    rx("b.example", { lat: 3, lon: 4 }),
  ];

  // Value: protects=the listening dot is named and the previous one says "last", connecting ones aren't labeled, and a receiver isn't both; fails_when=a connecting receiver gets a label, or the last label sits on the receiver playing; why_new=design decisions 5 and 9; seam=none; no_claim=label placement on screen
  it("labels the listening receiver and the last one", () => {
    const listening = markFeatures(
      list,
      { host: "a.example", port: 8073, phase: "listening" },
      { host: "b.example", port: 8073 },
    );
    expect(listening.features.map((f) => f.properties)).toEqual([
      { label: shortName("A very long receiver name that goes on and on"), last: false },
      { label: "last", last: true },
    ]);
    const connecting = markFeatures(list, { host: "a.example", port: 8073, phase: "connecting" }, null);
    expect(connecting.features).toEqual([]);
    const same = markFeatures(
      list,
      { host: "b.example", port: 8073, phase: "listening" },
      { host: "b.example", port: 8073 },
    );
    expect(same.features.map((f) => f.properties.label)).toEqual(["b.example"]);
  });

  it("cuts long names at 28 characters", () => {
    expect(shortName("A very long receiver name that goes on and on")).toBe("A very long receiver name t…");
    expect(shortName("Short")).toBe("Short");
  });
});
