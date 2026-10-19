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

  it("throws the typed value away on Escape", () => {
    const { onChange, input } = setup();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("10,000.00");
  });
});
