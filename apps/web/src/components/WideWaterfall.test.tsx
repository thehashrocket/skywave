// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WideFrame } from "@/lib/use-radio";
import { placeLabels, WideWaterfall } from "./WideWaterfall";

// jsdom has no canvas: a context that takes the calls, so frames reach the component.
const strokes = vi.fn();
beforeAll(() => {
  const ctx = {
    fillStyle: "",
    fillRect() {},
    drawImage() {},
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
    // The spectrum trace's calls.
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke: strokes,
    closePath() {},
    fill() {},
  };
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});
afterEach(cleanup);

function show(over: Partial<Parameters<typeof WideWaterfall>[0]> = {}) {
  let send: ((f: WideFrame) => void) | undefined;
  const onTune = vi.fn();
  const props = {
    view: { zoom: 9, cfKhz: 9_650 },
    freqKhz: 9_650,
    passband: [9_645.5, 9_654.5] as [number, number],
    frozen: false,
    error: null,
    subscribe: (fn: (f: WideFrame) => void) => {
      send = fn;
      return () => {};
    },
    onTune,
    ...over,
  };
  const view = render(<WideWaterfall {...props} />);
  const frame = (startKhz: number, spanKhz: number) =>
    act(() => send!({ startKhz, spanKhz, row: new Float32Array(1024).fill(140) }));
  const screenEl = view.container.querySelector<HTMLElement>(".waterfall-screen")!;
  screenEl.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
  return { view, frame, onTune, screenEl, props };
}

describe("WideWaterfall", () => {
  // Value: protects=the receiver's waterfall draws its spectrum trace from each frame, in a trace canvas above the picture inside the clickable screen (so the tuned mark and passband cross it); fails_when=the trace canvas isn't handed to the painter or sits outside the screen; why_new=spectrum trace; seam=canvas context faked; no_claim=what the line looks like (browser check)
  it("draws the spectrum trace from each frame, above the picture", () => {
    const { frame, screenEl } = show();
    const [trace, picture] = Array.from(screenEl.querySelectorAll("canvas"));
    expect(trace!.className).toBe("waterfall-trace");
    expect(picture!.className).toBe("waterfall-picture");
    strokes.mockClear();
    frame(9_600, 100);
    expect(strokes).toHaveBeenCalledTimes(1);
  });

  // Value: protects=until its first frame the wide view says it's opening and can't be clicked, then it tunes to the RF frequency under the click; fails_when=an empty picture tunes, the opening note stays, or the click maths uses the wrong start or span; why_new=wideband waterfall; seam=canvas context faked; no_claim=what the drawing looks like
  it("opens, then tunes to the frequency under a click", () => {
    const { frame, onTune, screenEl } = show();
    expect(screen.getByText("Opening the receiver's waterfall…")).toBeTruthy();
    fireEvent.click(screenEl, { clientX: 500 });
    expect(onTune).not.toHaveBeenCalled();
    frame(9_620, 60);
    expect(screen.queryByText("Opening the receiver's waterfall…")).toBeNull();
    fireEvent.click(screenEl, { clientX: 250 });
    expect(onTune).toHaveBeenCalledWith(9_635);
  });

  // Value: protects=the marks and axis follow where frames landed (a receiver keeps a view inside its coverage), not where the view was asked for; fails_when=the tuned mark, passband or ticks stay at the asked-for position; why_new=wideband waterfall; seam=canvas context faked; no_claim=label overlap (browser check)
  it("places the marks and axis where the frames landed", () => {
    const { frame, view } = show({ view: { zoom: 7, cfKhz: 50 }, freqKhz: 100, passband: [95.5, 104.5] });
    frame(0, 200);
    const center = view.container.querySelector<HTMLElement>(".waterfall-center")!;
    expect(center.style.left).toBe("50%");
    const band = view.container.querySelector<HTMLElement>(".waterfall-passband")!;
    expect(parseFloat(band.style.left)).toBeCloseTo(47.75);
    expect(parseFloat(band.style.width)).toBeCloseTo(4.5);
    const ticks = Array.from(view.container.querySelectorAll(".waterfall-axis > span:not(.waterfall-unit)")).map(
      (s) => s.textContent,
    );
    expect(ticks).toEqual(["25", "50", "75", "100", "125", "150", "175"]);
  });

  // Value: protects=after a move to a new view the picture takes no clicks until that view's first frame says where it landed; fails_when=a click on the blank picture tunes by where the view was asked for (a receiver may have moved it inside its coverage); why_new=web review; seam=canvas context faked; no_claim=none
  it("takes clicks again only once the new view's first frame lands", () => {
    const { frame, onTune, view, props } = show();
    frame(9_620, 60);
    view.rerender(<WideWaterfall {...props} view={{ zoom: 7, cfKhz: 9_650 }} />);
    const screenEl = view.container.querySelector<HTMLElement>(".waterfall-screen")!;
    screenEl.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
    fireEvent.click(screenEl, { clientX: 500 });
    expect(onTune).not.toHaveBeenCalled();
    expect(screen.queryByText("Opening the receiver's waterfall…")).toBeNull(); // not for a move
    frame(9_600, 200);
    fireEvent.click(screenEl, { clientX: 500 });
    expect(onTune).toHaveBeenCalledWith(9_700);
  });

  // Value: protects=a scan holds the picture with a note and no clicks (owner: freeze with "Scanning…"), and a view error is announced in its place; fails_when=frozen or errored pictures still tune, or the error isn't an alert; why_new=wideband waterfall; seam=canvas context faked; no_claim=none
  it("holds still for a scan and announces an error", () => {
    const first = show({ frozen: true });
    first.frame(9_620, 60);
    expect(screen.getByText(/Scanning the bands/)).toBeTruthy();
    fireEvent.click(first.screenEl, { clientX: 250 });
    expect(first.onTune).not.toHaveBeenCalled();
    cleanup();
    const second = show({ error: "Couldn't show this receiver's waterfall: busy" });
    second.frame(9_620, 60);
    expect(screen.getByRole("alert").textContent).toBe("Couldn't show this receiver's waterfall: busy");
    fireEvent.click(second.screenEl, { clientX: 250 });
    expect(second.onTune).not.toHaveBeenCalled();
  });

  // Value: protects=the tuned mark leaves the picture when the dial is outside it, and the passband is clipped at its edge; fails_when=marks are drawn off the picture or past its sides; why_new=wideband waterfall; seam=canvas context faked; no_claim=none
  it("hides the tuned mark off the picture and clips the passband", () => {
    const { frame, view } = show({ freqKhz: 9_700, passband: [9_678, 9_690] });
    frame(9_620, 60);
    expect(view.container.querySelector(".waterfall-center")).toBeNull();
    const band = view.container.querySelector<HTMLElement>(".waterfall-passband")!;
    expect(parseFloat(band.style.left)).toBeCloseTo((58 / 60) * 100);
    expect(parseFloat(band.style.left) + parseFloat(band.style.width)).toBeCloseTo(100);
  });

  // Value: protects=every scheduled station in view gets a mark at its frequency and only those in view; labels go nearest the tuned frequency first and only where they fit; fails_when=marks land at the wrong place, off-picture stations show, or crowded labels overlap; why_new=owner decision: names on the waterfall; seam=canvas context faked, width given directly; no_claim=the label's look (browser check)
  it("marks scheduled stations and names the ones that fit", () => {
    const { frame, view } = show({
      stations: [
        { khz: 9_500, label: "Out of view" },
        { khz: 9_635, label: "Left" },
        { khz: 9_650, label: "Tuned" },
        { khz: 9_652, label: "Crowded" },
      ],
    });
    frame(9_620, 60);
    const marks = Array.from(view.container.querySelectorAll<HTMLElement>(".waterfall-station"));
    expect(marks.map((m) => parseFloat(m.style.left))).toEqual([25, 50, expect.closeTo(53.33, 1)]);
    // jsdom has no layout, so it's the placement rule on its own here.
    expect([...placeLabels([0.25, 0.5, 0.5333], 0.5, 1000)]).toEqual([1, 0]);
    expect([...placeLabels([0.02, 0.5], 0.02, 1000)]).toEqual([1]);
    // Before the width is known: one label, the tuned station's.
    expect([...placeLabels([0.4, 0.5], 0.5, 0)]).toEqual([1]);
  });
});
