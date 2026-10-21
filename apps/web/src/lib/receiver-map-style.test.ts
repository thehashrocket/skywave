import { describe, expect, it } from "vitest";
import { buildStyle, FALLBACK_TOKENS, resolveTokens, TILES_URL, TOKEN_VARS } from "./receiver-map-style";

describe("resolveTokens", () => {
  // Value: protects=the map takes the page's palette, and still draws when a token is missing; fails_when=blank getComputedStyle values (jsdom, a stylesheet that failed) reach MapLibre as "" colors; why_new=E2 (pure buildStyle with fallbacks); seam=the read function; no_claim=the browser's CSS cascade
  it("uses the page's values and falls back for blank ones", () => {
    const tokens = resolveTokens((name) => (name === TOKEN_VARS.sea ? " #000011 " : ""));
    expect(tokens).toEqual({ ...FALLBACK_TOKENS, sea: "#000011" });
  });
});

describe("buildStyle", () => {
  const style = buildStyle({ ...FALLBACK_TOKENS, land: "#123456", dot: "#abcdef" });
  const layer = (id: string) => style.layers.find((l) => l.id === id)!;

  // Value: protects=the base map is the minimal one (sea, land, coastline, borders) from OpenFreeMap, with no key; fails_when=roads/places/POIs creep in, or the tile source changes host; why_new=design decision 8; seam=none; no_claim=what the tiles contain
  it("draws only sea, land, coastlines and borders from OpenFreeMap", () => {
    expect(style.sources.openmaptiles).toEqual({ type: "vector", url: TILES_URL });
    const tileLayers = style.layers.filter((l) => "source" in l && l.source === "openmaptiles");
    expect(tileLayers.map((l) => ("source-layer" in l ? l["source-layer"] : null))).toEqual([
      "water",
      "water",
      "boundary",
    ]);
    expect(layer("land")).toMatchObject({ paint: { "background-color": "#123456" } });
  });

  // Value: protects=dot styling can be keyed by receiver (feature state needs stable ids); fails_when=promoteId is dropped and setFeatureState silently does nothing; why_new=R3; seam=none; no_claim=MapLibre's behaviour
  it("keys the receivers source by host:port and draws night under the dots", () => {
    expect(style.sources.receivers).toMatchObject({ type: "geojson", promoteId: "key" });
    const order = style.layers.map((l) => l.id);
    expect(order.indexOf("twilight")).toBeLessThan(order.indexOf("night"));
    expect(order.indexOf("night")).toBeLessThan(order.indexOf("receiver-dots"));
    expect(JSON.stringify(layer("receiver-dots"))).toContain("#abcdef");
  });
});
