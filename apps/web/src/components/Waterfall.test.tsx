// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPainter, FALLBACK_STOPS, parseColor, resolveStops, traceYs, Waterfall } from "./Waterfall";

// jsdom has no canvas; the drawing isn't what's under test here.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});
afterEach(cleanup);

function show(over: { active?: boolean; expanded?: boolean; connecting?: boolean } = {}) {
  return render(
    <Waterfall
      mode="am"
      sampleRate={12_000}
      active={over.active ?? false}
      expanded={over.expanded ?? false}
      connecting={over.connecting ?? false}
      subscribe={() => () => {}}
      onClickOffset={() => {}}
    />,
  );
}

describe("Waterfall", () => {
  // Value: protects=the colormap follows the --wf-* tokens and falls back to today's colors when one can't be read (design D13); fails_when=the stops are hard-coded again, a token is read at the wrong index, or a blank value breaks the map; why_new=Waterfall had no test; seam=none; no_claim=how the canvas draws
  it("reads its colors from the tokens, falling back stop by stop", () => {
    const tokens: Record<string, string> = { "--wf-0": " #0b1e24", "--wf-2": "rgb(1, 2, 3)", "--wf-4": "not a color" };
    expect(resolveStops((name) => tokens[name] ?? "")).toEqual([
      [11, 30, 36],
      FALLBACK_STOPS[1],
      [1, 2, 3],
      FALLBACK_STOPS[3],
      FALLBACK_STOPS[4],
    ]);
    expect(parseColor("#FFF8DE")).toEqual([255, 248, 222]);
    expect(parseColor("")).toBeNull();

    // And the mounted waterfall uses them: its first fill is the lowest stop.
    const fills: string[] = [];
    const ctx = {
      set fillStyle(v: string) {
        fills.push(v);
      },
      fillRect() {},
      clearRect() {},
    };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof getContext;
    document.documentElement.style.setProperty("--wf-0", "#010203");
    try {
      show();
      expect(fills[0]).toBe("rgb(1,2,3)");
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
      document.documentElement.style.removeProperty("--wf-0");
    }
  });

  // Value: protects=before the visit's first audio the waterfall is a short strip pointing at Listen, and once open it says what it's waiting for (design D7); fails_when=the strip text or the open flag is dropped; why_new=Waterfall had no test; seam=none; no_claim=the strip's height (CSS, browser check)
  it("is a strip pointing at Listen until it has opened", () => {
    const view = show();
    expect(view.container.querySelector(".waterfall")!.hasAttribute("data-open")).toBe(false);
    expect(screen.getByText(/Press Listen to hear the band/)).toBeTruthy();
    cleanup();
    // A tune under way says so instead of asking for Listen (review finding).
    show({ connecting: true });
    expect(screen.getByText("Tuning in…")).toBeTruthy();
    cleanup();
    // Listening, but no audio yet: still the strip, not clickable, still saying so.
    const early = show({ active: true });
    expect(screen.getByText("Tuning in…")).toBeTruthy();
    const screenEl = early.container.querySelector(".waterfall-screen")!;
    expect(screenEl.hasAttribute("data-active")).toBe(false);
    expect(screenEl.getAttribute("title")).toBeNull();
    cleanup();
    const open = show({ expanded: true });
    expect(open.container.querySelector(".waterfall")!.hasAttribute("data-open")).toBe(true);
    expect(screen.getByText("The waterfall fills in once you're listening.")).toBeTruthy();
  });

  // Value: protects=screen readers get the click sentence and touch screens a tap one that readers skip (design D16, eng review code quality); fails_when=the tap sentence is announced or the click sentence is removed; why_new=the hint was a hover title only; seam=none; no_claim=which sentence shows for which pointer (CSS)
  it("hints at tapping or clicking a signal, announcing only one", () => {
    show({ active: true, expanded: true });
    expect(screen.getByText("Click a signal to tune to it.").getAttribute("aria-hidden")).toBeNull();
    expect(screen.getByText("Tap a signal to tune to it.").getAttribute("aria-hidden")).toBe("true");
  });

  // Value: protects=a tap on the idle strip or a stopped waterfall doesn't shift the frequency it can't show (red-team review); fails_when=handleClick tunes while inactive; why_new=the idle strip is new and tappable; seam=none; no_claim=hit areas
  it("tunes on a click only while audio is playing", () => {
    for (const active of [false, true]) {
      const onClickOffset = vi.fn();
      const view = render(
        <Waterfall
          mode="am"
          sampleRate={12_000}
          active={active}
          expanded
          connecting={false}
          subscribe={() => () => {}}
          onClickOffset={onClickOffset}
        />,
      );
      fireEvent.click(view.container.querySelector(".waterfall-screen")!, { clientX: 0 });
      expect(onClickOffset).toHaveBeenCalledTimes(active ? 1 : 0);
      cleanup();
    }
    // Playing but still the collapsed strip (no audio heard yet): nothing to aim at either.
    const onClickOffset = vi.fn();
    const view = render(
      <Waterfall
        mode="am"
        sampleRate={12_000}
        active
        expanded={false}
        connecting={false}
        subscribe={() => () => {}}
        onClickOffset={onClickOffset}
      />,
    );
    fireEvent.click(view.container.querySelector(".waterfall-screen")!, { clientX: 0 });
    expect(onClickOffset).not.toHaveBeenCalled();
  });

  // Value: protects=the spectrum trace uses the waterfall's own window (the floor at the bottom, 55 dB above it at the top), so a spike on the trace is the bright line under it; fails_when=the trace scales differently from the picture, is upside down, or runs off the canvas; why_new=spectrum trace; seam=none; no_claim=how the line looks
  it("places the trace on the waterfall's levels, clamped to the canvas", () => {
    const ys = traceYs(Float32Array.from([-110, -100, -72.5, -45, 0]), -100, 64);
    expect(Array.from(ys)).toEqual([63, 63, 32, 1, 1]);
  });

  // Value: protects=each row draws the trace across every bin, steadied against the last one, and a clear (a new view) wipes it and drops the old line instead of easing in from it; fails_when=the trace isn't drawn, ignores the hold, or a new view's trace starts from the old view's levels; why_new=spectrum trace; seam=canvas contexts faked; no_claim=the colors or line width
  it("draws the trace from each row, steadied, and starts over on a clear", () => {
    const picture = {
      fillStyle: "",
      fillRect() {},
      drawImage() {},
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    };
    const lines: number[][] = [];
    const cleared = vi.fn();
    const trace = {
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 0,
      clearRect: cleared,
      beginPath: () => lines.push([]),
      moveTo: (_x: number, y: number) => lines.at(-1)!.push(y),
      lineTo: (_x: number, y: number) => lines.at(-1)!.push(y),
      stroke() {},
      closePath() {},
      fill() {},
    };
    const traceCanvas = document.createElement("canvas");
    traceCanvas.height = 64;
    const painter = createPainter(
      document.createElement("canvas"),
      picture as unknown as CanvasRenderingContext2D,
      { canvas: traceCanvas, ctx: trace as unknown as CanvasRenderingContext2D },
    );
    // A flat floor with one strong bin: the first row sets the floor (and the line) outright.
    const row = new Float32Array(8).fill(-100);
    row[3] = -45;
    painter.paint(row);
    expect(traceCanvas.width).toBe(8);
    // Eight points on the line, then two closing it along the bottom for the wash.
    // The picture's window starts 3 dB under the floor, so the floor sits just above the bottom.
    const floorY = 1 + 62 * (1 - 3 / 55);
    expect(lines[0]!.slice(0, 8)).toEqual(
      [floorY, floorY, floorY, 1, floorY, floorY, floorY, floorY].map((y) => expect.closeTo(y, 3)),
    );
    // The spike goes: the line falls only part way, steadied by the last row.
    painter.paint(new Float32Array(8).fill(-100));
    expect(lines[1]![3]).toBeGreaterThan(1);
    expect(lines[1]![3]).toBeLessThan(floorY - 1);
    // A new view: the trace is wiped and the next row draws straight from its own levels.
    painter.clear();
    expect(cleared).toHaveBeenCalled();
    painter.paint(row);
    expect(lines[2]![3]).toBeCloseTo(1, 0);
  });

  // Value: protects=the audio waterfall draws its spectrum trace from each row, in a trace canvas above the picture inside the clickable screen; fails_when=the trace canvas isn't handed to the painter or sits outside the screen; why_new=spectrum trace; seam=canvas context faked; no_claim=what the line looks like (browser check)
  it("draws the spectrum trace from each row, above the picture", () => {
    const stroke = vi.fn();
    const ctx = {
      fillStyle: "",
      fillRect() {},
      drawImage() {},
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
      clearRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke,
      closePath() {},
      fill() {},
    };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof getContext;
    try {
      let send: ((row: Float32Array, rate: number) => void) | undefined;
      const view = render(
        <Waterfall
          mode="am"
          sampleRate={12_000}
          active
          expanded
          connecting={false}
          subscribe={(fn) => {
            send = fn;
            return () => {};
          }}
          onClickOffset={() => {}}
        />,
      );
      const canvases = view.container.querySelectorAll(".waterfall-screen canvas");
      expect(Array.from(canvases, (c) => c.className)).toEqual(["waterfall-trace", "waterfall-picture"]);
      send!(new Float32Array(512).fill(-100), 12_000);
      expect(stroke).toHaveBeenCalledTimes(1);
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
  });

  // Value: protects=the fallback colormap (tests, a missing token) stays equal to the --wf-* tokens in globals.css (review finding); fails_when=someone recolors one side only; why_new=two copies of the same five colors; seam=source text; no_claim=how the canvas renders them
  it("keeps its fallback colors equal to the --wf-* tokens", () => {
    // jsdom gives import.meta.url an http scheme, so find the stylesheet from where the tests run.
    const path = ["src/app/globals.css", "apps/web/src/app/globals.css"].find((p) => existsSync(p))!;
    const css = readFileSync(path, "utf8");
    const token = (name: string): string => {
      const value = new RegExp(`${name}:\\s*([^;]+);`).exec(css)![1]!.trim();
      const ref = /^var\((--[\w-]+)\)$/.exec(value);
      return ref ? token(ref[1]!) : value;
    };
    expect(FALLBACK_STOPS.map((_, i) => parseColor(token(`--wf-${i}`)))).toEqual(FALLBACK_STOPS);
  });
});
