"use client";

import { lazy, Suspense, useCallback, useState } from "react";
import { receiverKey, type Receiver } from "@/lib/kiwi-list";
import type { Follow, MapPlaying, Place } from "@/lib/receiver-map-model";
import { formatHostPort } from "@/lib/receiver";
import type { SolarClock } from "@/lib/use-solar-clock";

const ReceiverMap = lazy(() => import("./ReceiverMap"));

/** The list's age turns to a warning past this. */
const OLD_LIST_MS = 30 * 60_000;

/** The shared receiver list query, as the map needs it. */
export type MapList = {
  receivers: readonly Receiver[] | undefined;
  /** How old the server's copy is now, by its own clock plus this browser's time since; undefined with no list. */
  ageMs: number | undefined;
  /** The first load failed and there's no list to draw. */
  failed: boolean;
  retry: () => void;
};

type Props = {
  /** The radio has started (or the page has been idle): the map may load. */
  admitted: boolean;
  list: MapList;
  freqKhz: number;
  sun: SolarClock | null;
  playing: MapPlaying | null;
  last: Place | null;
  onListen: (r: Receiver) => void;
  /** Opens the receiver table, for when the map can't be drawn. */
  onBrowse: () => void;
};

/**
 * The receiver map's panel. Always rendered, with its space reserved, so the
 * page doesn't jump when the map arrives; the MapLibre adapter loads only
 * once admitted and then stays mounted.
 */
export function MapPanel({ admitted, list, freqKhz, sun, playing, last, onListen, onBrowse }: Props) {
  const [follow, setFollow] = useState<Follow>("follow");
  const [centerRequest, setCenterRequest] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  // Retry remounts the adapter, which removes the old map first.
  const [attempt, setAttempt] = useState(0);
  const onUserMove = useCallback(() => setFollow("stay"), []);
  const onFail = useCallback((reason: string) => setFailure(reason), []);

  const receivers = list.receivers;
  const playingReceiver = playing && receivers?.find((r) => receiverKey(r) === receiverKey(playing));
  const located = playingReceiver?.lat !== undefined && playingReceiver?.lon !== undefined;
  const freqText = freqKhz.toLocaleString("en-US");

  return (
    <section className="map-panel" aria-labelledby="map-heading">
      <div className="map-header">
        <h3 id="map-heading" className="map-heading">
          Receiver map · {freqText} kHz
        </h3>
        {playing && (
          <button
            type="button"
            className="map-center"
            aria-label="Center on receiver"
            disabled={!located}
            onClick={() => {
              setFollow("follow");
              setCenterRequest((n) => n + 1);
            }}
          >
            Center
          </button>
        )}
      </div>

      <div className="map-frame" role="region" aria-label="Receiver map" tabIndex={-1} data-map-region>
        {admitted && !failure ? (
          <Suspense fallback={null}>
            <ReceiverMap
              key={attempt}
              receivers={receivers ?? []}
              freqKhz={freqKhz}
              sun={sun}
              playing={playing}
              last={last}
              follow={follow}
              centerRequest={centerRequest}
              onUserMove={onUserMove}
              onListen={onListen}
              onFail={onFail}
            />
          </Suspense>
        ) : (
          !failure && <p className="map-shell">Map loads once the radio is playing</p>
        )}

        {failure ? (
          <div className="map-overlay">
            <p>Map unavailable: {failure}.</p>
            <p>
              <button
                type="button"
                className="link-button inline"
                onClick={() => {
                  setFailure(null);
                  setAttempt((n) => n + 1);
                }}
              >
                Retry map
              </button>{" "}
              ·{" "}
              <button type="button" className="link-button inline" onClick={onBrowse}>
                Browse receivers
              </button>
            </p>
          </div>
        ) : admitted && list.failed ? (
          <div className="map-overlay">
            <p>Receiver list unavailable.</p>
            <button type="button" className="link-button inline" onClick={list.retry}>
              Retry receiver list
            </button>
          </div>
        ) : admitted && receivers && !receivers.some((r) => r.lat !== undefined) ? (
          <div className="map-overlay">
            <p>No receivers to show</p>
          </div>
        ) : null}

        {playing && receivers && !located && (
          <p className="map-chip">
            Playing {playingReceiver?.name ?? formatHostPort(playing.host, playing.port)} · no location
          </p>
        )}
      </div>

      <p className="map-legend">
        <span>
          Shaded: night now · <span className="key-night">●</span> night · <span className="key-full">○</span> full ·
          faint: can&apos;t tune {freqText} · <span className="key-listening">●</span> listening ·{" "}
          <span className="key-last">○</span> last
        </span>
        <span className="map-legend-times">
          {sun && `Greyline ${utcTime(sun.at)} UTC`}
          {sun && list.ageMs !== undefined && " · "}
          {list.ageMs !== undefined && (
            <span data-old={list.ageMs > OLD_LIST_MS || undefined}>List {listAge(list.ageMs)}</span>
          )}
        </span>
      </p>
      <p className="map-note">
        Shaded areas are in darkness now. Night often carries distant shortwave; Pick best still ranks by signal and
        load.
      </p>
    </section>
  );
}

function utcTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function listAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "just fetched";
  if (minutes < 60) return `${minutes} min old`;
  return `${Math.round(minutes / 60)} h old`;
}
