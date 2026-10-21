"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import {
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
  type ErrorEvent,
  type GeoJSONSource,
  type MapMouseEvent,
} from "maplibre-gl";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { receiverKey, type Receiver } from "@/lib/kiwi-list";
import {
  cameraTarget,
  changedStates,
  dotStates,
  HIT_RADIUS,
  hitGroup,
  markFeatures,
  receiverFeatures,
  shortName,
  type DotState,
  type Follow,
  type MapPlaying,
  type Place,
} from "@/lib/receiver-map-model";
import { buildStyle, DOT_LAYER, resolveTokens, SOURCES } from "@/lib/receiver-map-style";
import { formatHostPort } from "@/lib/receiver";
import { darkRegion, NIGHT_ELEVATION, TWILIGHT_ELEVATION, type SunPosition } from "@/lib/solar";

// maplibre-gl 6 expects its worker beside its own module, which the bundler
// doesn't copy; the app serves it (app/vendor/maplibre).
setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");

/** The first view: the whole inhabited world. */
const WORLD: [[number, number], [number, number]] = [
  [-180, -58],
  [180, 75],
];
/** This many tile errors within the window and the map gives up. */
const TILE_ERROR_LIMIT = 5;
const TILE_ERROR_WINDOW_MS = 30_000;

export type ReceiverMapProps = {
  receivers: readonly Receiver[];
  freqKhz: number;
  sun: SunPosition | null;
  playing: MapPlaying | null;
  last: Place | null;
  follow: Follow;
  /** Changes each time Center is pressed, so the camera goes back even if it's already following. */
  centerRequest: number;
  onUserMove: () => void;
  onListen: (r: Receiver) => void;
  /** The map can't be drawn; the reason is shown to the user. */
  onFail: (reason: string) => void;
};

type Card = { keys: string[]; more: boolean; lngLat: [number, number] };

const reducedMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The MapLibre adapter. Loaded only once the page admits the map, and kept
 * mounted from then on; everything it decides comes from receiver-map-model.
 */
export default function ReceiverMap({
  receivers,
  freqKhz,
  sun,
  playing,
  last,
  follow,
  centerRequest,
  onUserMove,
  onListen,
  onFail,
}: ReceiverMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  // Bumped on every camera move, so the card follows its dot.
  const [, setMoved] = useState(0);
  const applied = useRef<Map<string, DotState> | null>(null);
  const callbacks = useRef({ onUserMove, onFail });
  callbacks.current = { onUserMove, onFail };

  const byKey = useMemo(() => new Map(receivers.map((r) => [receiverKey(r), r])), [receivers]);
  const drawn = useMemo(() => receivers.filter((r) => r.lat !== undefined && r.lon !== undefined), [receivers]);
  const drawnRef = useRef(drawn);
  drawnRef.current = drawn;

  // Create the map once; remove it (and its WebGL context) on unmount, which
  // is also how Retry starts over.
  useEffect(() => {
    const container = containerRef.current!;
    let created: MapLibreMap;
    try {
      created = new MapLibreMap({
        container,
        style: buildStyle(resolveTokens((name) => getComputedStyle(container).getPropertyValue(name))),
        bounds: WORLD,
        cooperativeGestures: true,
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        renderWorldCopies: false,
      });
    } catch {
      callbacks.current.onFail("this browser can't draw it (WebGL is off or unsupported)");
      return;
    }
    created.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    created.touchZoomRotate.disableRotation();

    let loaded = false;
    let failed = false;
    const tileErrors: number[] = [];
    const fail = (reason: string) => {
      if (failed) return;
      failed = true;
      callbacks.current.onFail(reason);
    };
    created.on("load", () => {
      loaded = true;
      setMap(created);
    });
    created.on("error", (e: ErrorEvent & { tile?: unknown }) => {
      // Before load, anything but a tile failing is the style itself.
      if (!loaded && !e.tile) return fail("the map style didn't load");
      const now = Date.now();
      tileErrors.push(now);
      while (tileErrors[0]! < now - TILE_ERROR_WINDOW_MS) tileErrors.shift();
      if (tileErrors.length >= TILE_ERROR_LIMIT) fail("map tiles aren't loading");
    });
    // Only the user's own pans and zooms stop the camera following; ours carry no originalEvent.
    for (const type of ["dragstart", "zoomstart"] as const) {
      created.on(type, (e: { originalEvent?: unknown }) => {
        if (e.originalEvent) callbacks.current.onUserMove();
      });
    }
    created.on("move", () => setMoved((n) => n + 1));

    const hits = (e: MapMouseEvent, radius: number) =>
      hitGroup(
        drawnRef.current.map((r) => {
          const p = created.project([r.lon!, r.lat!]);
          return { key: receiverKey(r), x: p.x, y: p.y };
        }),
        e.point,
        radius,
      );
    created.on("click", (e) => {
      const touch = (e.originalEvent as PointerEvent).pointerType === "touch";
      const { keys, more } = hits(e, touch ? HIT_RADIUS.touch : HIT_RADIUS.mouse);
      setTooltip(null);
      setCard(keys.length ? { keys, more, lngLat: [e.lngLat.lng, e.lngLat.lat] } : null);
    });
    created.on("mousemove", (e) => {
      const { keys } = hits(e, HIT_RADIUS.mouse);
      created.getCanvas().style.cursor = keys.length ? "pointer" : "";
      setTooltip(keys.length ? { text: keys[0]!, x: e.point.x, y: e.point.y } : null);
    });
    created.on("mouseout", () => setTooltip(null));

    return () => {
      setMap(null);
      applied.current = null;
      created.remove();
    };
  }, []);

  // A new list replaces the source, which drops all feature state: re-apply it (R3).
  useEffect(() => {
    if (!map) return;
    (map.getSource(SOURCES.receivers) as GeoJSONSource).setData(receiverFeatures(drawn));
    applied.current = null;
  }, [map, drawn]);

  // Dot states: only the ones that changed, at most once per frame (dial drags).
  useEffect(() => {
    if (!map) return;
    const frame = requestAnimationFrame(() => {
      const next = dotStates(drawn, { sun, freqKhz, playing, last });
      for (const [key, s] of changedStates(applied.current, next)) {
        map.setFeatureState({ source: SOURCES.receivers, id: key }, { ...s, phase: s.phase ?? "none" });
      }
      applied.current = next;
    });
    return () => cancelAnimationFrame(frame);
  }, [map, drawn, sun, freqKhz, playing, last]);

  // The greyline, each minute.
  useEffect(() => {
    if (!map || !sun) return;
    for (const [source, elevation] of [
      [SOURCES.twilight, NIGHT_ELEVATION],
      [SOURCES.night, TWILIGHT_ELEVATION],
    ] as const) {
      (map.getSource(source) as GeoJSONSource).setData({
        type: "Feature",
        properties: {},
        geometry: { type: "MultiPolygon", coordinates: darkRegion(sun, elevation) },
      });
    }
  }, [map, sun]);

  // Labels on the listening and last receivers.
  useEffect(() => {
    if (!map) return;
    (map.getSource(SOURCES.marks) as GeoJSONSource).setData(markFeatures(drawn, playing, last));
  }, [map, drawn, playing, last]);

  // Follow the receiver playing until the user moves the map; Center brings it back.
  const playingKey = playing && `${receiverKey(playing)}/${playing.phase}`;
  useEffect(() => {
    if (!map) return;
    const target = cameraTarget(follow, playing, drawn);
    if (!target) return;
    if (reducedMotion()) map.jumpTo({ center: target });
    else map.easeTo({ center: target, duration: 600 });
    // Only a new receiver, a new follow state or Center moves the camera, not each list refresh.
  }, [map, follow, playingKey, centerRequest]);

  // Esc closes the card and leaves focus on the map.
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setCard(null);
      containerRef.current?.closest<HTMLElement>("[data-map-region]")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card]);

  const cardReceivers = card ? card.keys.map((k) => byKey.get(k)).filter((r): r is Receiver => !!r) : [];
  const at = card && map ? map.project(card.lngLat) : null;

  return (
    <>
      <div ref={containerRef} className="map-canvas" aria-hidden="true" />
      {tooltip && (
        <div className="map-tooltip" style={{ left: tooltip.x, top: tooltip.y }} aria-hidden="true">
          {byKey.get(tooltip.text)?.name ?? tooltip.text}
        </div>
      )}
      {card && cardReceivers.length > 0 && (
        <div
          className="map-card"
          role="dialog"
          aria-label={cardReceivers.length > 1 ? "Receivers here" : cardReceivers[0]!.name}
          style={at ? ({ "--card-x": `${at.x}px` } as CSSProperties) : undefined}
        >
          <button type="button" className="map-card-close" aria-label="Close" onClick={() => setCard(null)}>
            ✕
          </button>
          <ul className="map-card-list">
            {cardReceivers.map((r) => (
              <li key={receiverKey(r)} className="map-card-item">
                <span className="receiver-name" title={r.name}>
                  {shortName(r.name)}
                </span>
                <span className="receiver-host">
                  {formatHostPort(r.host, r.port)}
                  {r.antenna && ` · ${r.antenna}`}
                </span>
                <span className="map-card-fields">
                  {r.location && <span>{r.location}</span>}
                  <span>SNR {r.snr ?? "–"}</span>
                  <span>
                    Listeners {r.users}/{r.usersMax}
                  </span>
                  <span>
                    {formatKhz(r.minKhz)}–{formatKhz(r.maxKhz)} kHz
                  </span>
                </span>
                <button
                  type="button"
                  className="map-listen"
                  onClick={() => {
                    setCard(null);
                    onListen(r);
                  }}
                >
                  Listen
                </button>
              </li>
            ))}
          </ul>
          {card.more && (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                map?.easeTo({ center: card.lngLat, zoom: map.getZoom() + 3, duration: reducedMotion() ? 0 : 600 });
                setCard(null);
              }}
            >
              Zoom into this area
            </button>
          )}
        </div>
      )}
    </>
  );
}

function formatKhz(khz: number): string {
  return Math.round(khz).toLocaleString("en-US");
}
