/**
 * The receiver map's look: a minimal style on OpenFreeMap's vector tiles
 * (sea, land, coastlines and borders; no roads, places or POIs), the night
 * shading, and the dots. Pure, so it's tested without a browser; colors
 * come from the page's --map-* tokens.
 */

import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";

export type MapTokens = {
  sea: string;
  land: string;
  rule: string;
  night: string;
  twilight: string;
  dot: string;
  playing: string;
  last: string;
  /** The ring round the listening dot. */
  needle: string;
  /** Labels on the listening and last dots. */
  label: string;
  /** IBP beacons and the path from the selected one. */
  beacon: string;
};

/** The CSS custom property each token is read from. */
export const TOKEN_VARS: Record<keyof MapTokens, string> = {
  sea: "--map-sea",
  land: "--map-land",
  rule: "--map-rule",
  night: "--map-night",
  twilight: "--map-twilight",
  dot: "--map-dot",
  playing: "--map-playing",
  last: "--map-last",
  needle: "--needle",
  label: "--lamp",
  beacon: "--map-beacon",
};

/** globals.css's values, for when the stylesheet can't be read (tests, a style that failed). */
export const FALLBACK_TOKENS: MapTokens = {
  sea: "#0b1e24",
  land: "#1b3f4a",
  rule: "#2b5560",
  night: "rgba(0, 0, 0, 0.31)",
  twilight: "rgba(0, 0, 0, 0.2)",
  dot: "#d4e6d8",
  playing: "#f2c55c",
  last: "rgba(212, 230, 216, 0.45)",
  needle: "#c8322b",
  label: "#f2c55c",
  beacon: "#c19a4b",
};

/** Reads the tokens through `read` (getComputedStyle in the browser); blank values fall back. */
export function resolveTokens(read: (name: string) => string): MapTokens {
  const tokens = { ...FALLBACK_TOKENS };
  for (const key of Object.keys(TOKEN_VARS) as (keyof MapTokens)[]) {
    const value = read(TOKEN_VARS[key]).trim();
    if (value) tokens[key] = value;
  }
  return tokens;
}

export const TILES_URL = "https://tiles.openfreemap.org/planet";
const GLYPHS_URL = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
/** OpenFreeMap serves Noto Sans; the page's Barlow isn't available as map glyphs. */
const LABEL_FONT = ["Noto Sans Bold"];

/** Source and layer ids the adapter updates. */
export const SOURCES = {
  twilight: "twilight",
  night: "night",
  receivers: "receivers",
  marks: "marks",
  beacons: "beacons",
  beaconPath: "beacon-path",
} as const;
export const DOT_LAYER = "receiver-dots";

const state = (name: string): ExpressionSpecification => ["boolean", ["feature-state", name], false];
const phase: ExpressionSpecification = ["coalesce", ["feature-state", "phase"], "none"];
const tuned: ExpressionSpecification = ["!=", phase, "none"];

/** Day dots are dimmer; night ones full strength; out of range overrides both. */
const markOpacity: ExpressionSpecification = ["case", tuned, 1, state("outOfRange"), 0.2, state("night"), 1, 0.55];

const emptyCollection = { type: "FeatureCollection" as const, features: [] };

export function buildStyle(t: MapTokens): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      openmaptiles: { type: "vector", url: TILES_URL },
      [SOURCES.twilight]: { type: "geojson", data: emptyCollection },
      [SOURCES.night]: { type: "geojson", data: emptyCollection },
      [SOURCES.receivers]: { type: "geojson", data: emptyCollection, promoteId: "key" },
      [SOURCES.marks]: { type: "geojson", data: emptyCollection },
      [SOURCES.beacons]: { type: "geojson", data: emptyCollection },
      [SOURCES.beaconPath]: { type: "geojson", data: emptyCollection },
    },
    layers: [
      { id: "land", type: "background", paint: { "background-color": t.land } },
      {
        id: "water",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        filter: ["!=", ["get", "brunnel"], "tunnel"],
        paint: { "fill-color": t.sea },
      },
      {
        id: "coastline",
        type: "line",
        source: "openmaptiles",
        "source-layer": "water",
        filter: ["!=", ["get", "brunnel"], "tunnel"],
        paint: { "line-color": t.rule, "line-width": 0.5 },
      },
      {
        id: "borders",
        type: "line",
        source: "openmaptiles",
        "source-layer": "boundary",
        filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
        paint: { "line-color": t.rule, "line-width": 0.5 },
      },
      // After sunset (lighter), then after civil twilight on top: 0.45 together.
      { id: "twilight", type: "fill", source: SOURCES.twilight, paint: { "fill-color": t.twilight } },
      { id: "night", type: "fill", source: SOURCES.night, paint: { "fill-color": t.night } },
      // The selected beacon's path, under the receiver dots so it ends beneath the receiver, not over it.
      {
        id: "beacon-path",
        type: "line",
        source: SOURCES.beaconPath,
        layout: { "line-cap": "round" },
        paint: { "line-color": t.beacon, "line-width": 1.5, "line-dasharray": [2, 2] },
      },
      {
        id: DOT_LAYER,
        type: "circle",
        source: SOURCES.receivers,
        paint: {
          // Playback starting gets one brief, larger dot (ReceiverMap clears it).
          "circle-radius": ["case", state("emphasis"), 9, tuned, 6, 4],
          "circle-color": ["case", ["==", phase, "listening"], t.playing, t.dot],
          // Full and connecting dots are rings.
          "circle-opacity": [
            "case",
            ["==", phase, "listening"],
            1,
            ["any", ["==", phase, "connecting"], state("full")],
            0,
            markOpacity,
          ],
          "circle-stroke-color": [
            "case",
            ["==", phase, "listening"],
            t.needle,
            ["==", phase, "connecting"],
            t.playing,
            state("last"),
            t.last,
            state("full"),
            t.dot,
            t.sea,
          ],
          "circle-stroke-width": ["case", tuned, 1.5, state("full"), 1.5, ["any", state("last"), state("night")], 1, 0],
          "circle-stroke-opacity": markOpacity,
        },
      },
      {
        id: "receiver-labels",
        type: "symbol",
        source: SOURCES.marks,
        layout: {
          "text-field": ["get", "label"],
          "text-font": LABEL_FONT,
          "text-size": 12,
          // One line: names are already cut to 28 characters.
          "text-max-width": 30,
          "text-transform": "uppercase",
          "text-anchor": "left",
          "text-offset": [0.8, 0],
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": ["case", ["get", "last"], t.last, t.label],
          "text-halo-color": t.sea,
          "text-halo-width": 1,
        },
      },
      // Beacons, over the receivers: filled while on the air, a faint ring otherwise; the selected one larger, ringed in red.
      // One NCDXF lists as off the air (#69) is dimmer still, and never filled.
      {
        id: "beacon-dots",
        type: "circle",
        source: SOURCES.beacons,
        paint: {
          "circle-radius": ["case", ["get", "selected"], 7, ["get", "onAir"], 5, 3.5],
          "circle-color": t.beacon,
          "circle-opacity": ["case", ["get", "onAir"], 1, 0],
          "circle-stroke-color": ["case", ["get", "selected"], t.needle, t.beacon],
          "circle-stroke-width": ["case", ["get", "selected"], 2, 1.5],
          "circle-stroke-opacity": [
            "case",
            ["get", "off"],
            0.25,
            ["any", ["get", "onAir"], ["get", "selected"]],
            1,
            0.6,
          ],
        },
      },
      {
        id: "beacon-labels",
        type: "symbol",
        source: SOURCES.beacons,
        filter: ["!=", ["get", "label"], ""],
        layout: {
          "text-field": ["get", "label"],
          "text-font": LABEL_FONT,
          "text-size": 11,
          "text-anchor": "right",
          "text-offset": [-0.8, 0],
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": t.beacon,
          "text-opacity": ["case", ["get", "off"], 0.45, 1],
          "text-halo-color": t.sea,
          "text-halo-width": 1,
        },
      },
    ],
  };
}
