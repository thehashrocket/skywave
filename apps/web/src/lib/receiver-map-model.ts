/**
 * The receiver map's logic, kept apart from MapLibre so it can be tested:
 * which receivers become dots, how each one is drawn, what a click hits, and
 * whether the camera follows the receiver playing.
 */

import { greatCirclePath } from "./great-circle";
import { BEACONS, beaconOnBand, findBeacon, IBP_BANDS_KHZ } from "./ibp";
import { covers, isFull, receiverKey, type Receiver } from "./kiwi-list";
import { isNight, type SunPosition } from "./solar";

export type Place = { host: string; port: number };

/** A receiver being tuned or played, as the page knows it. */
export type MapPlaying = Place & { phase: "connecting" | "listening" };

/** GeoJSON for the receivers with a position. Each feature's `key` is its MapLibre id (promoteId). */
export function receiverFeatures(receivers: readonly Receiver[]) {
  return {
    type: "FeatureCollection" as const,
    features: receivers.flatMap((r) =>
      r.lat === undefined || r.lon === undefined
        ? []
        : [
            {
              type: "Feature" as const,
              geometry: { type: "Point" as const, coordinates: [r.lon, r.lat] },
              properties: { key: receiverKey(r), full: isFull(r) },
            },
          ],
    ),
  };
}

/** Labels beside the listening dot (its name) and the last one ("last"). Connecting dots get none. */
export function markFeatures(receivers: readonly Receiver[], playing: MapPlaying | null, last: Place | null) {
  const marks: { r: Receiver; label: string; last: boolean }[] = [];
  const find = (p: Place) => receivers.find((r) => r.host === p.host && r.port === p.port);
  const listening = playing?.phase === "listening" ? find(playing) : undefined;
  if (listening) marks.push({ r: listening, label: shortName(listening.name), last: false });
  const lastR = last && !(playing && receiverKey(playing) === receiverKey(last)) ? find(last) : undefined;
  if (lastR) marks.push({ r: lastR, label: "last", last: true });
  return {
    type: "FeatureCollection" as const,
    features: marks.flatMap(({ r, label, last }) =>
      r.lat === undefined || r.lon === undefined
        ? []
        : [
            {
              type: "Feature" as const,
              geometry: { type: "Point" as const, coordinates: [r.lon, r.lat] },
              properties: { label, last },
            },
          ],
    ),
  };
}

/** Names longer than this are cut, with an ellipsis (design: 28ch). */
export const NAME_LIMIT = 28;

export function shortName(name: string): string {
  // By user-visible character (a flag or an emoji with a skin tone is one), never part of one.
  const chars =
    typeof Intl.Segmenter === "function"
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name), (s) => s.segment)
      : Array.from(name);
  return chars.length > NAME_LIMIT
    ? `${chars
        .slice(0, NAME_LIMIT - 1)
        .join("")
        .trimEnd()}…`
    : name;
}

/** How one dot is drawn; MapLibre feature state, read by the style's paint expressions. */
export type DotState = {
  night: boolean;
  outOfRange: boolean;
  full: boolean;
  phase: "connecting" | "listening" | null;
  last: boolean;
};

type StateInput = {
  sun: SunPosition | null;
  freqKhz: number;
  playing: MapPlaying | null;
  last: Place | null;
};

/** Every drawn receiver's dot state, by key. */
export function dotStates(receivers: readonly Receiver[], { sun, freqKhz, playing, last }: StateInput) {
  const playingKey = playing && receiverKey(playing);
  const lastKey = last && receiverKey(last);
  const states = new Map<string, DotState>();
  for (const r of receivers) {
    if (r.lat === undefined || r.lon === undefined) continue;
    const key = receiverKey(r);
    states.set(key, {
      night: sun ? isNight(r.lat, r.lon, sun) : false,
      outOfRange: !covers(r, freqKhz),
      full: isFull(r),
      phase: key === playingKey ? playing!.phase : null,
      last: key === lastKey && key !== playingKey,
    });
  }
  return states;
}

/**
 * The states that differ from what was applied last, so a minute tick or a
 * dial move touches only the dots that change. With no previous states (a new
 * list, which drops all feature state), every state is returned.
 */
export function changedStates(prev: ReadonlyMap<string, DotState> | null, next: ReadonlyMap<string, DotState>) {
  const changed: [string, DotState][] = [];
  for (const [key, state] of next) {
    const old = prev?.get(key);
    if (
      !old ||
      old.night !== state.night ||
      old.outOfRange !== state.outOfRange ||
      old.full !== state.full ||
      old.phase !== state.phase ||
      old.last !== state.last
    ) {
      changed.push([key, state]);
    }
  }
  return changed;
}

/** Most receivers a card lists before it asks you to zoom in. */
export const CARD_LIMIT = 10;

/** Hit radius in CSS pixels: a finger is wider than a pointer. */
export const HIT_RADIUS = { mouse: 10, touch: 22 } as const;

/**
 * The receivers under a click: every dot within `radius` pixels, nearest
 * first, so a site with several ports (or dots too close to tell apart)
 * lists them all. `more` says some were left out.
 */
export function hitGroup(
  dots: readonly { key: string; x: number; y: number }[],
  at: { x: number; y: number },
  radius: number,
  limit = CARD_LIMIT,
): { keys: string[]; more: boolean } {
  const near = dots
    .map((d) => ({ key: d.key, d: Math.hypot(d.x - at.x, d.y - at.y) }))
    .filter((d) => d.d <= radius)
    .sort((a, b) => a.d - b.d || a.key.localeCompare(b.key));
  return { keys: near.slice(0, limit).map((d) => d.key), more: near.length > limit };
}

/**
 * The IBP beacon layer (issue #59), while beacon mode is on: `atMs` is any
 * time in the slot to show (server clock), `selected` the callsign picked with
 * Listen, if any.
 */
export type BeaconLayer = { atMs: number; selected: string | null };

/**
 * All 18 beacons as points. The five on the air in the slot carry their
 * frequency in MHz, which the map shows beside the callsign; the rest are
 * drawn faint. The selected one is labeled whether it's on the air or not.
 */
export function beaconFeatures(layer: BeaconLayer) {
  const onAir = new Map(IBP_BANDS_KHZ.map((khz, b) => [beaconOnBand(layer.atMs, b).call, khz]));
  return {
    type: "FeatureCollection" as const,
    features: BEACONS.map((b) => {
      const khz = onAir.get(b.call);
      const selected = b.call === layer.selected;
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [b.lon, b.lat] },
        properties: {
          call: b.call,
          onAir: khz !== undefined,
          selected,
          label: khz !== undefined ? `${b.call} ${(khz / 1000).toFixed(3)}` : selected ? b.call : "",
        },
      };
    }),
  };
}

/**
 * The great-circle path from the selected beacon to the receiver playing or
 * connecting (the one Pick best is trying), as GeoJSON; empty with no beacon
 * selected or no receiver at a known place.
 */
export function beaconPathFeatures(
  layer: BeaconLayer | null,
  playing: MapPlaying | null,
  receivers: readonly Receiver[],
) {
  const beacon = layer?.selected ? findBeacon(layer.selected) : undefined;
  const key = playing && receiverKey(playing);
  const r = key ? receivers.find((x) => receiverKey(x) === key) : undefined;
  if (!beacon || !r || r.lat === undefined || r.lon === undefined)
    return { type: "FeatureCollection" as const, features: [] };
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        geometry: {
          type: "MultiLineString" as const,
          coordinates: greatCirclePath(beacon, { lat: r.lat, lon: r.lon }),
        },
        properties: {},
      },
    ],
  };
}

/**
 * The camera follows the receiver playing until you pan or zoom; then it
 * stays put until you press Center.
 */
export type Follow = "follow" | "stay";

/**
 * Where the camera should go now, if anywhere: the receiver playing, while
 * following. Not one still connecting: a switch that fails mustn't move the
 * view away from where you were looking.
 */
export function cameraTarget(
  follow: Follow,
  playing: MapPlaying | null,
  receivers: readonly Receiver[],
): [number, number] | null {
  if (follow !== "follow" || playing?.phase !== "listening") return null;
  const key = receiverKey(playing);
  const r = receivers.find((x) => receiverKey(x) === key);
  return r && r.lat !== undefined && r.lon !== undefined ? [r.lon, r.lat] : null;
}
