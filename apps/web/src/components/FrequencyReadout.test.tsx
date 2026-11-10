// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrequencyReadout, parseFrequencyKhz, WHEEL_REST_MS } from "./FrequencyReadout";

afterEach(cleanup);

describe("parseFrequencyKhz", () => {
  it.each([
    ["9,535.00", 9535],
    ["7030.5", 7030.5],
    ["10 000 kHz", 10000],
    ["12.345", 12.35], // rounded to 10 Hz
    ["30000", 30000],
    ["30000.01", null],
    ["0", null],
    ["", null],
    ["abc", null],
    ["1.2.3", null],
    // Units, and what used to be stripped (eng review R8, design D8).
    ["7.2 MHz", 7200],
    ["7.2M", 7200],
    ["7200kHz", 7200],
    ["7,200.5 k", 7200.5],
    ["-100", null],
    ["9.6 GHz", null],
    ["40000", null],
    ["9", null], // below the dial's 10 kHz
    // A bare "m" after a whole number is a band name, not MHz (review finding).
    ["20m", null],
    ["49m", null],
    ["7.2m", 7200],
    ["15 MHz", 15000],
    // Commas only as thousands separators (review finding).
    ["1,5 MHz", null],
    ["9,6", null],
    ["72,00", null],
    ["7,200", 7200],
    ["7 200", 7200],
    ["1 0", null],
    // Over the 32-character cap: rejected before any regex runs (it once backtracked for seconds).
    ["1" + " ".repeat(2_000) + "x", null],
    ["7.2" + " ".repeat(40) + "MHz", null],
    [" 7.2 MHz ", 7200],
    ["12,345.6", 12345.6],
  ])("%j → %s", (text, khz) => {
    expect(parseFrequencyKhz(text)).toBe(khz);
  });
});

describe("FrequencyReadout", () => {
  function setup() {
    const onChange = vi.fn();
    render(<FrequencyReadout freqKhz={10_000} onChange={onChange} />);
    const input = screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement;
    act(() => input.focus()); // real focus, so the component's blur() actually fires onBlur
    fireEvent.change(input, { target: { value: "7030" } });
    return { onChange, input };
  }

  it("tunes to a typed frequency on Enter", () => {
    const { onChange, input } = setup();
    fireEvent.submit(input.form!);
    expect(onChange).toHaveBeenCalledWith(7030);
  });

  // Value: protects=a value that isn't a tunable frequency stays in the box, flagged and explained, instead of being rewritten or silently undone (design D8); fails_when=the text is replaced, nothing is flagged, or the message never clears; why_new=rejects used to snap back silently; seam=none; no_claim=how a screen reader reads aria-invalid
  it("keeps a rejected entry, flags it, and clears the flag on a good one or Escape", () => {
    const { onChange, input } = setup();
    fireEvent.change(input, { target: { value: "-100" } });
    fireEvent.submit(input.form!);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("-100");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)!.textContent).toBe(
      "Enter 10 to 30,000 kHz",
    );
    expect(screen.getByRole("alert").textContent).toBe("Enter 10 to 30,000 kHz"); // announced, not only described

    act(() => input.blur());
    expect(input.value).toBe("-100"); // still there to fix after leaving the box

    act(() => input.focus());
    fireEvent.change(input, { target: { value: "7.2 MHz" } });
    fireEvent.submit(input.form!);
    expect(onChange).toHaveBeenCalledWith(7200);
    expect(input.getAttribute("aria-invalid")).toBeNull();

    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.submit(input.form!);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("Enter 10 to 30,000 kHz")).toBeNull();
  });

  // Value: protects=a rejected entry keeps its text and flag when something else retunes while the box is focused (review finding); fails_when=the box's remembered frequency goes stale mid-edit and the rejecting blur wipes the text; why_new=quality review; seam=none; no_claim=none beyond protects
  it("keeps a rejected entry through a retune from elsewhere", () => {
    const onChange = vi.fn();
    const view = render(<FrequencyReadout freqKhz={10_000} onChange={onChange} />);
    const input = screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "abc" } });
    view.rerender(<FrequencyReadout freqKhz={9_600} onChange={onChange} />);
    act(() => input.blur());
    expect(input.value).toBe("abc");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  // Value: protects=a rejected entry left in the box gives way when the dial, a preset or a list row retunes, so the box never shows a stale flagged value beside a working radio; fails_when=the hold-on-invalid guard ignores the frequency changing, or the flag outlives the new text; why_new=tests covered the hold, not its release; seam=none; no_claim=none beyond protects
  it("replaces a rejected entry left in the box when something else retunes", () => {
    const onChange = vi.fn();
    const view = render(<FrequencyReadout freqKhz={10_000} onChange={onChange} />);
    const input = screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "abc" } });
    act(() => input.blur());
    expect(input.getAttribute("aria-invalid")).toBe("true");
    view.rerender(<FrequencyReadout freqKhz={9_600} onChange={onChange} />);
    expect(input.value).toBe("9,600.00");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("");
  });

  // Value: protects=a value committed with Enter isn't sent again when the box is left (red-team review); fails_when=edited stays set after a commit; why_new=the blur fix made this reachable; seam=none; no_claim=real focus order
  it("doesn't send an Enter-committed value again on blur", () => {
    const onChange = vi.fn();
    const view = render(<FrequencyReadout freqKhz={10_000} onChange={onChange} />);
    const input = screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "7200" } });
    fireEvent.submit(input.form!);
    expect(onChange).toHaveBeenCalledTimes(1);
    view.rerender(<FrequencyReadout freqKhz={9_000} onChange={onChange} />); // the dial tuned meanwhile
    act(() => input.blur());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // Value: protects=leaving the box without typing (say, to click or tap the dial) doesn't re-tune to the frequency it showed on focus (red-team review); fails_when=blur commits an unedited draft; why_new=tap-to-tune on the dial makes this common; seam=none; no_claim=real focus order between pointer and mouse events
  it("doesn't re-tune when left without typing", () => {
    const onChange = vi.fn();
    const view = render(<FrequencyReadout freqKhz={10_000} onChange={onChange} />);
    const input = screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement;
    act(() => input.focus());
    view.rerender(<FrequencyReadout freqKhz={7_000} onChange={onChange} />); // the dial tuned meanwhile
    act(() => input.blur());
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("7,000.00");
  });

  it("throws the typed value away on Escape", () => {
    const { onChange, input } = setup();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("10,000.00");
  });
});

describe("FrequencyReadout stepping", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const input = () => screen.getByLabelText("Frequency in kilohertz") as HTMLInputElement;
  /** The pointer comes to rest on the number. */
  const rest = () => {
    fireEvent.pointerEnter(input());
    act(() => vi.advanceTimersByTime(WHEEL_REST_MS));
  };
  const wheel = (init: WheelEventInit) => {
    const e = new WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });
    act(() => {
      input().dispatchEvent(e);
    });
    return e;
  };

  // Value: protects=a page scroll that passes over the number keeps scrolling and never retunes (losing the station), however long it goes on, while a pointer that has rested there tunes; fails_when=the wheel tunes on any pointer over the number, or a wheel during the wait doesn't restart it; why_new=user flag on wheel tuning (scrolling past the readout changed the station); seam=fake timers; no_claim=real pointer and momentum-scroll timing
  it("lets a page scroll pass over the number, and tunes once the pointer rests", () => {
    const onChange = vi.fn();
    render(<FrequencyReadout freqKhz={9_580} onChange={onChange} step={5} />);
    fireEvent.pointerEnter(input());
    for (let i = 0; i < 5; i++) {
      expect(wheel({ deltaY: 100 }).defaultPrevented).toBe(false);
      act(() => vi.advanceTimersByTime(WHEEL_REST_MS - 1)); // still scrolling: each wheel restarts the wait
    }
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(wheel({ deltaY: -100 }).defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(9_585);
    fireEvent.pointerLeave(input());
    fireEvent.pointerEnter(input());
    expect(wheel({ deltaY: -100 }).defaultPrevented).toBe(false); // left and came back: wait again
  });

  // Value: protects=a notch tunes one step (up is up) without scrolling the page, Shift takes ten (also sideways), several notches before a re-render count on from each other, and a focused box (clicked or tabbed into) tunes at once and shows the new number; fails_when=the listener is passive, the direction is inverted, Shift is ignored, a notch re-reads the stale prop, focus doesn't arm it, or the focused box keeps the old number; why_new=wheel tuning (and the review's stale-number bug); seam=fake timers; no_claim=real wheel hardware
  it("steps by notch, ten with Shift, and tunes at once when focused", () => {
    const onChange = vi.fn();
    const view = render(<FrequencyReadout freqKhz={9_580} onChange={onChange} step={5} />);
    rest();
    wheel({ deltaY: -100 });
    expect(onChange).toHaveBeenLastCalledWith(9_585);
    wheel({ deltaY: -100 }); // before any re-render
    expect(onChange).toHaveBeenLastCalledWith(9_590);
    wheel({ deltaY: 100, shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(9_550);
    wheel({ deltaX: -100, shiftKey: true }); // Shift turns some mice sideways
    expect(onChange).toHaveBeenLastCalledWith(9_600);
    cleanup();

    const tuned = vi.fn();
    const focused = render(<FrequencyReadout freqKhz={9_580} onChange={tuned} step={5} />);
    act(() => input().focus());
    expect(wheel({ deltaY: -100 }).defaultPrevented).toBe(true);
    expect(tuned).toHaveBeenLastCalledWith(9_585);
    focused.rerender(<FrequencyReadout freqKhz={9_585} onChange={tuned} step={5} />);
    expect(input().value).toBe("9,585.00");
    view.unmount();
  });

  // Value: protects=a trackpad's small deltas add up to a notch rather than each tuning a step, and a reversal starts the count again; fails_when=every pixel delta steps (a flick races across the band) or the total survives a reversal; why_new=wheel tuning; seam=fake timers; no_claim=any particular trackpad's deltas
  it("adds up a trackpad's small deltas to one notch", () => {
    const onChange = vi.fn();
    render(<FrequencyReadout freqKhz={9_580} onChange={onChange} step={5} />);
    rest();
    for (const d of [-20, -20]) wheel({ deltaY: d });
    expect(onChange).not.toHaveBeenCalled();
    wheel({ deltaY: 30 }); // reversal: the count starts again at +30
    wheel({ deltaY: -20 }); // and again at -20
    expect(onChange).not.toHaveBeenCalled();
    wheel({ deltaY: -30 });
    expect(onChange).toHaveBeenLastCalledWith(9_585);
  });

  // Value: protects=the arrow keys step like the wheel (Shift ten) for keyboard users, but move the caret over typed text; fails_when=arrows don't step, step over typed text, or don't stop the caret moving; why_new=review: no keyboard fine-tuning in the readout; seam=none; no_claim=none beyond protects
  it("steps with the arrow keys, except over typed text", () => {
    const onChange = vi.fn();
    render(<FrequencyReadout freqKhz={9_580} onChange={onChange} step={5} />);
    act(() => input().focus());
    const up = fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(up).toBe(false); // default prevented
    expect(onChange).toHaveBeenLastCalledWith(9_585);
    fireEvent.keyDown(input(), { key: "ArrowDown", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(9_550); // ten steps: snaps to the 50 kHz grid below
    onChange.mockClear();
    fireEvent.change(input(), { target: { value: "95" } });
    expect(fireEvent.keyDown(input(), { key: "ArrowUp" })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  // Value: protects=stepping leaves typed text alone (the page scrolls) and comes back after Escape throws the text away; fails_when=the wheel overwrites what's being typed, or Escape leaves stepping off until the next focus; why_new=wheel tuning (and the review's Escape bug); seam=fake timers; no_claim=none beyond protects
  it("leaves typed text alone, and steps again after Escape", () => {
    const onChange = vi.fn();
    render(<FrequencyReadout freqKhz={9_580} onChange={onChange} step={5} />);
    act(() => input().focus());
    fireEvent.change(input(), { target: { value: "95" } });
    expect(wheel({ deltaY: -100 }).defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input().value).toBe("9,580.00");
    rest();
    wheel({ deltaY: -100 });
    expect(onChange).toHaveBeenLastCalledWith(9_585);
  });

  // Value: protects=without a step nothing steps and the page scrolls; fails_when=a missing step steps by NaN or swallows the wheel; why_new=wheel tuning; seam=fake timers; no_claim=none beyond protects
  it("does nothing without a step", () => {
    const onChange = vi.fn();
    render(<FrequencyReadout freqKhz={9_580} onChange={onChange} />);
    rest();
    expect(wheel({ deltaY: -100 }).defaultPrevented).toBe(false);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(onChange).not.toHaveBeenCalled();
  });

  // Value: protects=the scheduled station shows under the number and is read with the field (aria-describedby), a shared frequency's other listings open from "+N more" by keyboard or touch, and the line gives way to typing another frequency and to a rejected entry's message; fails_when=the name is missing or silent to a screen reader, the others are hover-only, the old name sits under a new frequency being typed, or it and the error both show; why_new=owner decision: a name under the readout, plus review (a11y); seam=none; no_claim=how far the name is cut short (CSS)
  it("names the scheduled station under the number, readable and openable, until it's typed over", () => {
    const station = { text: "KBS World Radio · English +1 more", all: "KBS World Radio · English\nRadio Y · Mandarin" };
    const { rerender } = render(<FrequencyReadout freqKhz={9_580} onChange={() => {}} station={station} />);
    const input = screen.getByRole("textbox", { name: "Frequency in kilohertz" });
    expect(input.getAttribute("aria-describedby")).toBe("freq-station");
    expect(document.getElementById("freq-station")!.textContent).toBe("KBS World Radio · English +1 more");
    expect(screen.queryByText("Radio Y · Mandarin")).toBeNull();
    const more = screen.getByRole("button", { name: "+1 more" });
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("list", { name: "Also scheduled now" }).textContent).toBe("Radio Y · Mandarin");
    act(() => (input as HTMLInputElement).focus());
    fireEvent.change(input, { target: { value: "7200" } });
    expect(document.getElementById("freq-station")).toBeNull();
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.submit((input as HTMLInputElement).form!);
    expect(screen.getByRole("alert").textContent).toMatch(/Enter/);
    expect(input.getAttribute("aria-describedby")).toBe("freq-error");
    expect(document.getElementById("freq-station")).toBeNull();
    rerender(<FrequencyReadout freqKhz={9_580} onChange={() => {}} station={null} />);
    expect(document.querySelector(".readout-station")).toBeNull();
  });
});
