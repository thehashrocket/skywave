// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrequencyReadout, parseFrequencyKhz } from "./FrequencyReadout";

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
