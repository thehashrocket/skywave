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
    removed = false;
    // Like MapLibre: once removed, the map has no style and touching it throws.
    setFeatureState = vi.fn(() => {
      if (this.removed) throw new TypeError("Cannot read properties of undefined (reading 'setFeatureState')");
    });
    easeTo = vi.fn();
    jumpTo = vi.fn();
    remove = vi.fn(() => {
      this.removed = true;
    });
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
    canvas = {
      style: {} as Record<string, string>,
      tabIndex: 0,
      attrs: {} as Record<string, string>,
      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
      },
    };
    getCanvas() {
      return this.canvas;
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
  getVersion: () => "6.12.0",
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
  act(() => {
    map().emit("style.load");
    map().emit("load");
  });
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
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Receiver map");
  });

  // Value: protects=Esc while typing elsewhere on the page doesn't close the card or steal focus, but a click outside the map does close it; fails_when=the Esc handler acts on any key anywhere, or outside clicks leave a stale card; why_new=design review (PR 2b ship); seam=DOM events; no_claim=screen reader behaviour
  it("keeps Esc to the map and closes the card on an outside click", () => {
    render(
      <>
        <input aria-label="elsewhere" />
        <div data-map-region tabIndex={-1}>
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
        </div>
      </>,
    );
    load();
    const open = () =>
      act(() => map().emit("click", { point: { x: 300, y: 300 }, lngLat: { lng: 0, lat: 0 }, originalEvent: {} }));
    open();
    const elsewhere = screen.getByLabelText("elsewhere");
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(elsewhere);
    fireEvent.pointerDown(elsewhere);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Value: protects=closing the card with its own buttons leaves keyboard focus on the map, not the page; fails_when=✕ or Listen unmounts the focused button and focus drops to <body>; why_new=design review (PR 2b ship); seam=DOM focus; no_claim=screen reader behaviour
  it("returns focus to the map when the card's own button closes it", () => {
    render(
      <div data-map-region tabIndex={-1} aria-label="frame">
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
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.click(close);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("frame");
  });

  // Value: protects=the canvas is hidden from screen readers but the zoom and attribution controls are not; fails_when=aria-hidden goes back on the container that holds the controls, hiding focusable buttons; why_new=design review CRITICAL (PR 2b ship); seam=mocked canvas; no_claim=MapLibre's control markup
  it("hides only the canvas from assistive tech", () => {
    const { view } = setup();
    expect(map().canvas.attrs["aria-hidden"]).toBe("true");
    expect(map().canvas.tabIndex).toBe(-1);
    expect(view.container.querySelector(".map-canvas")!.hasAttribute("aria-hidden")).toBe(false);
  });

  // Value: protects=a receiver list that arrives after playback started still brings the camera to the receiver; fails_when=the camera effect ignores the target appearing (list loaded late or retried); why_new=testing + red team (PR 2b ship); seam=mocked easeTo; no_claim=animation
  it("follows once the playing receiver's position arrives", () => {
    const { rerender } = setup({ receivers: [], playing: { host: "a.example", port: 8073, phase: "listening" } });
    load();
    expect(map().easeTo).not.toHaveBeenCalled();
    rerender({ receivers: list });
    expect(map().easeTo).toHaveBeenCalledWith({ center: [100, 100], duration: 600 });
    map().easeTo.mockClear();
    rerender({ receivers: [...list] });
    expect(map().easeTo).not.toHaveBeenCalled();
  });

  // Value: protects=playback starting is marked once, briefly, and never under reduced motion; fails_when=the emphasis never clears, repeats on refreshes, or ignores the preference; why_new=design decision 11 (plan PARTIAL closed in PR 2b ship); seam=fake timers, mocked matchMedia; no_claim=how it looks
  it("emphasises the dot once when playback starts", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = setup();
      load();
      rerender({ playing: { host: "a.example", port: 8073, phase: "listening" } });
      const id = { source: "receivers", id: "a.example:8073" };
      expect(map().setFeatureState).toHaveBeenCalledWith(id, { emphasis: true });
      map().setFeatureState.mockClear();
      act(() => vi.advanceTimersByTime(600));
      expect(map().setFeatureState).toHaveBeenCalledWith(id, { emphasis: false });
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=a map whose style never arrives, or whose graphics context the browser drops, says so instead of sitting blank; fails_when=there's no load watchdog or no webglcontextlost handler; why_new=red team (PR 2b ship); seam=fake timers, mocked events; no_claim=MapLibre's own retry behaviour
  it("gives up on a style that never loads, and on a lost graphics context", () => {
    vi.useFakeTimers();
    try {
      const hung = setup();
      // One frame for the clock to start, then the full wait.
      act(() => vi.advanceTimersByTime(15_100));
      expect(hung.props.onFail).toHaveBeenCalledWith("the map style didn't load");
      cleanup();

      const lost = setup();
      load();
      act(() => vi.advanceTimersByTime(15_000));
      expect(lost.props.onFail).not.toHaveBeenCalled();
      act(() => map().emit("webglcontextlost"));
      expect(lost.props.onFail).toHaveBeenCalledWith("the browser dropped its graphics context");
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=a map that fails or unmounts while a receiver is listening tears down cleanly instead of throwing (which would crash the whole page past the map's error boundary); fails_when=an effect cleanup touches the map after remove(); why_new=cycle-2 review CRITICAL (PR 2b ship); seam=a fake whose setFeatureState throws after remove, like MapLibre; no_claim=MapLibre internals beyond that
  it("unmounts cleanly while a receiver is listening", () => {
    const { view, rerender } = setup();
    load();
    rerender({ playing: { host: "a.example", port: 8073, phase: "listening" } });
    expect(() => view.unmount()).not.toThrow();
  });

  // Value: protects=a map that's only slow (big first tiles, a background tab) isn't torn down; only a style that never arrives is; fails_when=the watchdog waits for the full "load" (tiles + animation frames); why_new=cycle-2 red team (PR 2b ship); seam=fake timers, mocked events; no_claim=real network timing
  it("times only the style, not the first tiles", () => {
    vi.useFakeTimers();
    try {
      const { props } = setup();
      act(() => map().emit("style.load"));
      act(() => vi.advanceTimersByTime(60_000));
      expect(props.onFail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Value: protects=a map built in a background tab (Listen, then switch tabs) isn't failed for the time the tab was hidden; fails_when=the watchdog starts at construction instead of the first animation frame, which hidden tabs don't get; why_new=cycle-3 red team CRITICAL (PR 2b ship); seam=a queued requestAnimationFrame, fake timers; no_claim=browser throttling details
  it("starts the style clock only once the tab draws a frame", () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    try {
      const { props } = setup();
      act(() => vi.advanceTimersByTime(120_000));
      expect(props.onFail).not.toHaveBeenCalled();
      act(() => frames.splice(0).forEach((cb) => cb(0)));
      act(() => vi.advanceTimersByTime(15_000));
      expect(props.onFail).toHaveBeenCalledWith("the map style didn't load");
    } finally {
      vi.useRealTimers();
    }
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
