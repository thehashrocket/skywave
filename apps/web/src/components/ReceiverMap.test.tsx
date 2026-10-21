// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Receiver } from "@/lib/kiwi-list";
import ReceiverMap, { type ReceiverMapProps } from "./ReceiverMap";

const fake = vi.hoisted(() => {
  type Handler = (e: Record<string, unknown>) => void;
  class FakeMap {
    static instances: FakeMap[] = [];
    static failNext = false;
    handlers = new Map<string, Handler[]>();
    sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    setFeatureState = vi.fn();
    easeTo = vi.fn();
    jumpTo = vi.fn();
    remove = vi.fn();
    addControl = vi.fn();
    touchZoomRotate = { disableRotation: vi.fn() };
    constructor(readonly options: Record<string, unknown>) {
      if (FakeMap.failNext) {
        FakeMap.failNext = false;
        throw new Error("Failed to initialize WebGL");
      }
      FakeMap.instances.push(this);
    }
    on(type: string, fn: Handler) {
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
      return this;
    }
    emit(type: string, e: Record<string, unknown> = {}) {
      for (const fn of this.handlers.get(type) ?? []) fn(e);
    }
    getSource(id: string) {
      if (!this.sources.has(id)) this.sources.set(id, { setData: vi.fn() });
      return this.sources.get(id);
    }
    // Screen pixels are just [lon, lat], so tests can aim clicks.
    project([lon, lat]: [number, number]) {
      return { x: lon, y: lat };
    }
    getCanvas() {
      return { style: {} };
    }
    getZoom() {
      return 2;
    }
  }
  return { FakeMap };
});

vi.mock("maplibre-gl", () => ({
  Map: fake.FakeMap,
  NavigationControl: class {},
  setWorkerUrl: vi.fn(),
}));

const map = () => fake.FakeMap.instances.at(-1)!;

function rx(host: string, over: Partial<Receiver> = {}): Receiver {
  return {
    id: host,
    name: `${host} name`,
    location: "Somewhere",
    antenna: "dipole",
    host,
    port: 8073,
    users: 1,
    usersMax: 8,
    snr: 20,
    minKhz: 0,
    maxKhz: 30_000,
    lat: 10,
    lon: 20,
    ...over,
  };
}

const list = [
  rx("a.example", { lon: 100, lat: 100 }),
  rx("b.example", { lon: 104, lat: 100 }),
  rx("far.example", { lon: 300, lat: 300 }),
  rx("nogps.example", { lat: undefined, lon: undefined }),
];

function setup(over: Partial<ReceiverMapProps> = {}) {
  const props: ReceiverMapProps = {
    receivers: list,
    freqKhz: 9_535,
    sun: { declination: 0, subsolarLon: 0 },
    playing: null,
    last: null,
    follow: "follow",
    centerRequest: 0,
    onUserMove: vi.fn(),
    onListen: vi.fn(),
    onFail: vi.fn(),
    ...over,
  };
  const view = render(<ReceiverMap {...props} />);
  const rerender = (next: Partial<ReceiverMapProps>) => {
    Object.assign(props, next);
    view.rerender(<ReceiverMap {...props} />);
  };
  return { props, view, rerender };
}

function load() {
  act(() => map().emit("load"));
}

beforeEach(() => {
  fake.FakeMap.instances.length = 0;
  // Dot states wait for a frame; run it at once.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReceiverMap", () => {
  // Value: protects=after load the map shows every located receiver, styles each one, and draws the night; fails_when=data is pushed before load, receivers without GPS are drawn, or the greyline/feature state is never set; why_new=T5; seam=maplibre-gl mocked (no WebGL in jsdom); no_claim=what MapLibre renders
  it("draws located receivers, their states and the night once loaded", () => {
    setup();
    expect(map().options).toMatchObject({
      cooperativeGestures: true,
      bounds: [
        [-180, -58],
        [180, 75],
      ],
    });
    expect(map().sources.size).toBe(0);
    load();
    const features = map().getSource("receivers")!.setData.mock.calls.at(-1)![0].features;
    expect(features.map((f: { properties: { key: string } }) => f.properties.key)).toEqual([
      "a.example:8073",
      "b.example:8073",
      "far.example:8073",
    ]);
    expect(map().setFeatureState).toHaveBeenCalledTimes(3);
    expect(map().getSource("night")!.setData).toHaveBeenCalledWith(
      expect.objectContaining({ geometry: expect.objectContaining({ type: "MultiPolygon" }) }),
    );
  });

  // Value: protects=a list refresh doesn't strip the dots' night/out-of-range look; fails_when=states are diffed against the old list after setData drops them; why_new=R3; seam=mocked map; no_claim=MapLibre dropping state (assumed from its docs)
  it("re-applies every state after a list refresh, and only changes after a dial move", () => {
    const { rerender } = setup();
    load();
    map().setFeatureState.mockClear();
    rerender({ receivers: [...list] });
    expect(map().setFeatureState).toHaveBeenCalledTimes(3);

    map().setFeatureState.mockClear();
    rerender({ freqKhz: 9_600 });
    expect(map().setFeatureState).not.toHaveBeenCalled();
    rerender({ receivers: list.map((r) => (r.host === "b.example" ? { ...r, minKhz: 9_550 } : r)) });
    map().setFeatureState.mockClear();
    rerender({ freqKhz: 9_500 });
    expect(map().setFeatureState).toHaveBeenCalledTimes(1);
    expect(map().setFeatureState).toHaveBeenCalledWith(
      { source: "receivers", id: "b.example:8073" },
      expect.objectContaining({ outOfRange: true, phase: "none" }),
    );
  });

  // Value: protects=a click only selects (lists everything under it) and only Listen switches receivers; fails_when=a dot click tunes, nearby dots are dropped, or Listen bypasses onListen (the page's chooseReceiver, which cancels Pick best); why_new=design D6, R1, R5; seam=mocked map events; no_claim=real pointer hit areas
  it("opens a card on click and switches only on Listen", () => {
    const { props } = setup();
    load();
    act(() => map().emit("click", { point: { x: 101, y: 100 }, lngLat: { lng: 1, lat: 2 }, originalEvent: {} }));
    expect(props.onListen).not.toHaveBeenCalled();
    const card = screen.getByRole("dialog", { name: "Receivers here" });
    expect(card.textContent).toContain("a.example name");
    expect(card.textContent).toContain("b.example name");
    expect(card.textContent).not.toContain("far.example");

    fireEvent.click(screen.getAllByRole("button", { name: "Listen" })[1]!);
    expect(props.onListen).toHaveBeenCalledWith(list[1]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Value: protects=a finger gets a bigger target than a mouse, and an empty spot closes the card; fails_when=touch uses the 10px mouse radius or a miss leaves a stale card; why_new=design D14; seam=pointerType on the mocked event; no_claim=real touch geometry
  it("uses a wider hit radius for touch and closes on an empty spot", () => {
    setup();
    load();
    act(() => map().emit("click", { point: { x: 115, y: 100 }, lngLat: { lng: 0, lat: 0 }, originalEvent: {} }));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() =>
      map().emit("click", {
        point: { x: 115, y: 100 },
        lngLat: { lng: 0, lat: 0 },
        originalEvent: { pointerType: "touch" },
      }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => map().emit("click", { point: { x: 0, y: 0 }, lngLat: { lng: 0, lat: 0 }, originalEvent: {} }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Value: protects=Esc dismisses the card and keyboard focus lands on the map, not the page; fails_when=Esc does nothing or focus is lost; why_new=design D15; seam=a region wrapper like MapPanel's; no_claim=screen reader output
  it("closes the card on Esc and returns focus to the map", () => {
    render(
      <div data-map-region tabIndex={-1} aria-label="Receiver map">
        <ReceiverMap
          receivers={list}
          freqKhz={9_535}
          sun={null}
          playing={null}
          last={null}
          follow="follow"
          centerRequest={0}
          onUserMove={() => {}}
          onListen={() => {}}
          onFail={() => {}}
        />
      </div>,
    );
    load();
    act(() => map().emit("click", { point: { x: 300, y: 300 }, lngLat: { lng: 0, lat: 0 }, originalEvent: {} }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Receiver map");
  });

  // Value: protects=only the user's own pan or zoom stops the camera following; fails_when=our own easeTo (no originalEvent) counts as a user move and follow switches itself off; why_new=design D8; seam=mocked events; no_claim=MapLibre's event payloads beyond originalEvent
  it("reports only user pans and zooms", () => {
    const { props } = setup();
    load();
    act(() => map().emit("zoomstart", {}));
    expect(props.onUserMove).not.toHaveBeenCalled();
    act(() => map().emit("dragstart", { originalEvent: {} }));
    expect(props.onUserMove).toHaveBeenCalledTimes(1);
  });

  // Value: protects=the camera goes to a receiver once it's listening, not while connecting, not after the user moved it, and again on Center; fails_when=follow ignores the phase, the stay state or the Center request; why_new=design D8, browser QA (PR 2b); seam=mocked easeTo; no_claim=animation
  it("follows the listening receiver and comes back on Center", () => {
    const { rerender } = setup();
    load();
    rerender({ playing: { host: "a.example", port: 8073, phase: "connecting" } });
    expect(map().easeTo).not.toHaveBeenCalled();
    rerender({ playing: { host: "a.example", port: 8073, phase: "listening" } });
    expect(map().easeTo).toHaveBeenCalledWith({ center: [100, 100], duration: 600 });
    // Value: protects=the listening dot gets its name label once it plays; fails_when=the marks source isn't updated when playing changes; why_new=markFeatures is unit-tested but its wiring to the map wasn't; seam=mocked map source; no_claim=label placement
    const labels = map().getSource("marks")!.setData.mock.calls.at(-1)![0].features;
    expect(labels.map((f: { properties: { label: string } }) => f.properties.label)).toEqual(["a.example name"]);

    map().easeTo.mockClear();
    rerender({ follow: "stay", playing: { host: "b.example", port: 8073, phase: "listening" } });
    expect(map().easeTo).not.toHaveBeenCalled();
    rerender({ follow: "follow", centerRequest: 1 });
    expect(map().easeTo).toHaveBeenCalledWith({ center: [104, 100], duration: 600 });
  });

  // Value: protects=someone who asked for reduced motion gets an instant camera move, not a 600 ms glide; fails_when=the prefers-reduced-motion check is dropped and follow always eases; why_new=only the animated path was tested; seam=a stubbed matchMedia; no_claim=MapLibre's own animation settings
  it("jumps instead of easing when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const { rerender } = setup();
    load();
    rerender({ playing: { host: "a.example", port: 8073, phase: "listening" } });
    expect(map().jumpTo).toHaveBeenCalledWith({ center: [100, 100] });
    expect(map().easeTo).not.toHaveBeenCalled();
  });

  // Value: protects=a crowded spot's card says there are more and Zoom into this area zooms there and closes the card; fails_when=the more flag isn't shown or the button doesn't move the camera; why_new=hitGroup's limit is unit-tested, the card's action wasn't; seam=mocked map; no_claim=real zoom levels or tile loading
  it("offers to zoom into a spot with more receivers than the card lists", () => {
    const crowd = Array.from({ length: 12 }, (_, i) => rx(`r${i}.example`, { lon: 100 + i / 2, lat: 100 }));
    setup({ receivers: crowd });
    load();
    act(() => map().emit("click", { point: { x: 100, y: 100 }, lngLat: { lng: 5, lat: 6 }, originalEvent: {} }));
    expect(screen.getAllByRole("button", { name: "Listen" })).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Zoom into this area" }));
    expect(map().easeTo).toHaveBeenCalledWith({ center: [5, 6], zoom: 5, duration: 600 });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Value: protects=a browser without WebGL, a style that won't load, or a tile host that's down ends in a stated reason instead of a blank panel; fails_when=a failure path is silent or tile errors outside the 30 s window still count; why_new=failure modes table, design state table; seam=mocked constructor and error events; no_claim=MapLibre's own error wording
  it("reports why the map can't be drawn", () => {
    fake.FakeMap.failNext = true;
    const noGl = setup();
    expect(noGl.props.onFail).toHaveBeenCalledWith(expect.stringContaining("WebGL"));
    cleanup();

    const style = setup();
    act(() => map().emit("error", { error: { message: "404" } }));
    expect(style.props.onFail).toHaveBeenCalledWith("the map style didn't load");
    cleanup();

    vi.useFakeTimers();
    try {
      const tiles = setup();
      load();
      for (let i = 0; i < 4; i++) act(() => map().emit("error", { tile: {}, error: { message: "x" } }));
      vi.advanceTimersByTime(31_000);
      act(() => map().emit("error", { tile: {}, error: { message: "x" } }));
      expect(tiles.props.onFail).not.toHaveBeenCalled();
      for (let i = 0; i < 4; i++) act(() => map().emit("error", { tile: {}, error: { message: "x" } }));
      expect(tiles.props.onFail).toHaveBeenCalledWith("map tiles aren't loading");
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=unmounting (and Retry, which remounts) frees the map's WebGL context; fails_when=remove() is never called and retries leak contexts until the browser refuses; why_new=E4; seam=mocked remove; no_claim=browser context limits
  it("removes the map when unmounted", () => {
    const { view } = setup();
    view.unmount();
    expect(map().remove).toHaveBeenCalledTimes(1);
  });
});
