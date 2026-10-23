// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Dial } from "./Dial";

// The dial's SVG spans 0–1000 px on screen here, so x = 20 + (kHz / 30,000) * 960.
const at = (khz: number) => 20 + (khz / 30_000) * 960;

beforeAll(() => {
  // jsdom lays nothing out; give the SVG a size and let pointer capture be a no-op.
  Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 1000, bottom: 160, width: 1000, height: 160, x: 0, y: 0, toJSON() {} };
  };
  Element.prototype.setPointerCapture = () => {};
});
afterEach(cleanup);

function setup(freqKhz = 10_000) {
  const onChange = vi.fn();
  const view = render(<Dial freqKhz={freqKhz} onChange={onChange} />);
  const dial = screen.getByRole("slider", { name: "Tuning dial" });
  return { onChange, dial, view };
}

describe("Dial", () => {
  // Value: protects=a mouse still tunes on press and drag, and arrow keys still step (regression for design D15); fails_when=the touch rules leak into mouse or keyboard input; why_new=Dial had no test; seam=none; no_claim=real pointer hardware
  it("tunes on mouse press and drag, and steps with the keys, as before", () => {
    const { onChange, dial } = setup();
    fireEvent.pointerDown(dial, { pointerType: "mouse", clientX: at(7_000), clientY: 50 });
    expect(onChange).toHaveBeenLastCalledWith(7_000);
    fireEvent.pointerMove(dial, { pointerType: "mouse", buttons: 1, clientX: at(7_200), clientY: 50 });
    expect(onChange).toHaveBeenLastCalledWith(7_200);
    fireEvent.pointerUp(dial, { pointerType: "mouse", clientX: at(7_200), clientY: 50 });
    onChange.mockClear();
    fireEvent.pointerMove(dial, { pointerType: "mouse", clientX: at(9_000), clientY: 50 });
    expect(onChange).not.toHaveBeenCalled(); // hovering after release doesn't tune
    fireEvent.keyDown(dial, { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(10_010);
  });

  // Value: protects=a page scroll that starts on the dial never retunes, while a sideways drag and a tap do (design D15); fails_when=touch tunes on pointerdown again, a vertical move counts as a drag, or pointercancel tunes; why_new=Dial had no test; seam=none; no_claim=the browser's own touch-action handling (synthetic events)
  it("tunes a touch only once it moves sideways, or on a tap, never on a scroll", () => {
    const { onChange, dial } = setup();
    // A thumb that starts a page scroll on the dial.
    fireEvent.pointerDown(dial, { pointerType: "touch", clientX: at(7_000), clientY: 50 });
    fireEvent.pointerMove(dial, { pointerType: "touch", clientX: at(7_000) + 3, clientY: 80 });
    fireEvent.pointerCancel(dial, { pointerType: "touch" });
    expect(onChange).not.toHaveBeenCalled();

    // A sideways drag tunes once past the slop, and keeps tuning.
    fireEvent.pointerDown(dial, { pointerType: "touch", clientX: at(7_000), clientY: 50 });
    fireEvent.pointerMove(dial, { pointerType: "touch", clientX: at(7_000) + 5, clientY: 50 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerMove(dial, { pointerType: "touch", clientX: at(7_500), clientY: 52 });
    expect(onChange).toHaveBeenLastCalledWith(7_500);
    fireEvent.pointerUp(dial, { pointerType: "touch", clientX: at(7_500), clientY: 52 });

    // A tap tunes where it lifts.
    onChange.mockClear();
    fireEvent.pointerDown(dial, { pointerType: "touch", clientX: at(15_000), clientY: 50 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(dial, { pointerType: "touch", clientX: at(15_000), clientY: 50 });
    expect(onChange).toHaveBeenCalledWith(15_000);
  });

  // Value: protects=on a phone a drag that ends near the strip's edge re-centers the strip, so repeated drags reach the whole dial (eng review R6); fails_when=nothing scrolls after a touch drag, or a drag in the middle scrolls too; why_new=Codex O1: the phone dial couldn't leave its first screen; seam=the scroll box's size and scrollTo are stubbed; no_claim=that a real phone scrolls (browser check with touch emulation)
  it("re-centers the strip on a needle dragged to its edge", () => {
    const { dial, view } = setup();
    const box = view.container.querySelector(".dial-scroll") as HTMLDivElement;
    Object.defineProperty(box, "scrollWidth", { value: 1000, configurable: true });
    Object.defineProperty(box, "clientWidth", { value: 390, configurable: true });
    box.scrollLeft = 0;
    const scrollTo = vi.fn();
    box.scrollTo = scrollTo as typeof box.scrollTo;

    const drag = (from: number, to: number) => {
      fireEvent.pointerDown(dial, { pointerType: "touch", clientX: from, clientY: 50 });
      fireEvent.pointerMove(dial, { pointerType: "touch", clientX: to, clientY: 50 });
      fireEvent.pointerUp(dial, { pointerType: "touch", clientX: to, clientY: 50 });
    };
    drag(200, 260); // ends mid-strip
    expect(scrollTo).not.toHaveBeenCalled();
    drag(260, 370); // ends within 40 px of the right edge
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 370 - 195, behavior: "smooth" });
    // Reduced motion jumps instead of scrolling smoothly.
    const matchMedia = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce") })) as unknown as typeof window.matchMedia;
    try {
      drag(260, 370);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 370 - 195, behavior: "auto" });
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  // Value: protects=no pointer press or key tunes below 10 kHz or above 30,000 kHz, though the scale starts at 0 (regression: both clamps moved into clampKhz); fails_when=clampKhz floors at DIAL_MIN_KHZ, or a handler stops clamping; why_new=no test pinned the dial's ends; seam=none; no_claim=the typed-entry range (FrequencyReadout tests)
  it("keeps pointer and key tuning within 10 to 30,000 kHz", () => {
    const { onChange, dial, view } = setup(10);
    fireEvent.keyDown(dial, { key: "PageDown" });
    expect(onChange).toHaveBeenLastCalledWith(10);
    fireEvent.pointerDown(dial, { pointerType: "mouse", clientX: 0, clientY: 50 });
    expect(onChange).toHaveBeenLastCalledWith(10);
    fireEvent.pointerUp(dial, { pointerType: "mouse", clientX: 0, clientY: 50 });

    view.rerender(<Dial freqKhz={29_950} onChange={onChange} />);
    fireEvent.keyDown(dial, { key: "PageUp" });
    expect(onChange).toHaveBeenLastCalledWith(30_000);
    fireEvent.pointerDown(dial, { pointerType: "mouse", clientX: 1000, clientY: 50 });
    expect(onChange).toHaveBeenLastCalledWith(30_000);
  });

  // Value: protects=on a phone the strip jumps (no smooth scroll) to a needle moved off-screen by anything but a drag, leaves an on-screen needle alone, and doesn't fight a mouse drag; fails_when=the effect is dropped, ignores the edge margin, or runs mid-drag; why_new=only the touch-drag re-center was tested; seam=the scroll box's size and scrollTo are stubbed; no_claim=that a real phone scrolls (browser check)
  it("re-centers the strip on a frequency set from elsewhere, not during a drag", () => {
    const { onChange, dial, view } = setup();
    const box = view.container.querySelector(".dial-scroll") as HTMLDivElement;
    Object.defineProperty(box, "scrollWidth", { value: 1000, configurable: true });
    Object.defineProperty(box, "clientWidth", { value: 390, configurable: true });
    Object.defineProperty(dial, "clientWidth", { value: 1000, configurable: true });
    box.scrollLeft = 0;
    const scrollTo = vi.fn();
    box.scrollTo = scrollTo as typeof box.scrollTo;

    // A mouse drag that carries the needle off-screen leaves the strip alone.
    fireEvent.pointerDown(dial, { pointerType: "mouse", clientX: at(10_000), clientY: 50 });
    view.rerender(<Dial freqKhz={25_000} onChange={onChange} />);
    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.pointerUp(dial, { pointerType: "mouse", clientX: at(25_000), clientY: 50 });

    // A preset or typed frequency off-screen (the needle at 852 px): center it, at once.
    view.rerender(<Dial freqKhz={26_000} onChange={onChange} />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: at(26_000) - 195, behavior: "auto" });

    // Already in view (the strip now shows 657–1047 px, the needle at 820): nothing moves.
    scrollTo.mockClear();
    box.scrollLeft = at(26_000) - 195;
    view.rerender(<Dial freqKhz={25_000} onChange={onChange} />);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  // Value: protects=screen readers get the keyboard sentence and touch screens a touch one readers skip (design D16, eng review code quality); fails_when=the touch sentence is announced or the keyboard one is removed; why_new=the hint was keyboard-only; seam=none; no_claim=which sentence shows for which pointer (CSS)
  it("hints for keyboard and touch, announcing only the keyboard sentence", () => {
    setup();
    expect(screen.getByText(/use the arrow keys/).getAttribute("aria-hidden")).toBeNull();
    expect(screen.getByText("Drag the dial or tap a band to tune.").getAttribute("aria-hidden")).toBe("true");
  });

  // Value: protects=a drag whose release went to another window, or a touch whose end never arrived, can't keep retuning the live receiver or lock the dial (adversarial review); fails_when=hover with no button held still tunes, or a lost touch blocks every later touch; why_new=press was only cleared by pointerup/cancel; seam=none; no_claim=real capture loss
  it("drops a press whose release it never saw", () => {
    const { onChange, dial } = setup();
    fireEvent.pointerDown(dial, { pointerType: "mouse", clientX: at(7_000), clientY: 50 });
    onChange.mockClear();
    fireEvent.pointerMove(dial, { pointerType: "mouse", buttons: 0, clientX: at(9_000), clientY: 50 });
    fireEvent.pointerMove(dial, { pointerType: "mouse", buttons: 0, clientX: at(9_500), clientY: 50 });
    expect(onChange).not.toHaveBeenCalled();

    // A touch whose pointerup was lost: the next primary touch still taps.
    fireEvent.pointerDown(dial, {
      pointerType: "touch",
      pointerId: 3,
      isPrimary: true,
      clientX: at(5_000),
      clientY: 50,
    });
    fireEvent.pointerDown(dial, {
      pointerType: "touch",
      pointerId: 4,
      isPrimary: true,
      clientX: at(12_000),
      clientY: 50,
    });
    fireEvent.pointerUp(dial, {
      pointerType: "touch",
      pointerId: 4,
      isPrimary: true,
      clientX: at(12_000),
      clientY: 50,
    });
    expect(onChange).toHaveBeenCalledWith(12_000);
  });

  // Value: protects=a second finger on the dial is ignored, so the needle follows one finger and doesn't retune back and forth (red-team review); fails_when=press ignores pointerId and the second finger overwrites the first; why_new=multi-touch was unhandled; seam=none; no_claim=real multi-touch hardware (synthetic events)
  it("follows only the first finger", () => {
    const { onChange, dial } = setup();
    fireEvent.pointerDown(dial, { pointerType: "touch", pointerId: 1, clientX: at(7_000), clientY: 50 });
    fireEvent.pointerDown(dial, { pointerType: "touch", pointerId: 2, clientX: at(20_000), clientY: 50 });
    fireEvent.pointerMove(dial, { pointerType: "touch", pointerId: 2, clientX: at(21_000), clientY: 50 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerMove(dial, { pointerType: "touch", pointerId: 1, clientX: at(7_500), clientY: 50 });
    expect(onChange).toHaveBeenLastCalledWith(7_500);
    fireEvent.pointerUp(dial, { pointerType: "touch", pointerId: 2, clientX: at(21_000), clientY: 50 });
    fireEvent.pointerMove(dial, { pointerType: "touch", pointerId: 1, clientX: at(8_000), clientY: 50 });
    expect(onChange).toHaveBeenLastCalledWith(8_000); // the second finger lifting didn't end the first's drag
  });
});
