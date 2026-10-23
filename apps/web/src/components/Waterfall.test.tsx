// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FALLBACK_STOPS, parseColor, resolveStops, Waterfall } from "./Waterfall";

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
