// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecodePanel } from "./DecodePanel";

afterEach(cleanup);

const noop = () => {};

describe("DecodePanel", () => {
  // Value: protects=the status line tells searching from locked (with the mark tone), and says when the service can't decode or nothing plays; fails_when=a locked decoder reads as searching, or an older service silently shows nothing; why_new=RTTY decoding (#92); seam=none; no_claim=the hook's state handling (use-radio tests)
  it("says what the decoder is doing", () => {
    const props = { text: "", onReverse: noop, onClear: noop, onOff: noop };
    const { rerender } = render(
      <DecodePanel {...props} state={{ state: "searching", reverse: false }} canDecode playing />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Looking for RTTY tones/);
    rerender(<DecodePanel {...props} state={{ state: "locked", markHz: 2124.6, reverse: false }} canDecode playing />);
    expect(screen.getByRole("status").textContent).toBe("Decoding. Mark tone at 2125 Hz.");
    rerender(<DecodePanel {...props} state={{ state: "searching", reverse: false }} canDecode={false} playing />);
    expect(screen.getByRole("status").textContent).toMatch(/can't decode RTTY yet/);
    rerender(<DecodePanel {...props} state={{ state: "searching", reverse: false }} canDecode playing={false} />);
    expect(screen.getByRole("status").textContent).toMatch(/once a receiver plays/);
    rerender(
      <DecodePanel {...props} state={{ state: "error", reverse: false, message: "It broke." }} canDecode playing />,
    );
    expect(screen.getByRole("status").textContent).toBe("It broke.");
    expect(screen.queryByRole("button", { name: "Reverse" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  // Value: protects=the text shows and the Reverse, Clear and Turn off buttons call back, Reverse showing its state; fails_when=a button is wired to the wrong callback or Reverse loses aria-pressed; why_new=RTTY decoding (#92); seam=none; no_claim=auto-scroll (jsdom has no layout)
  it("shows the text and wires its buttons", () => {
    const onReverse = vi.fn();
    const onClear = vi.fn();
    const onOff = vi.fn();
    render(
      <DecodePanel
        state={{ state: "locked", markHz: 1585, reverse: true }}
        text={"CQ CQ DE W1AW\nRYRY"}
        canDecode
        playing
        onReverse={onReverse}
        onClear={onClear}
        onOff={onOff}
      />,
    );
    expect(screen.getByLabelText("Decoded text").textContent).toBe("CQ CQ DE W1AW\nRYRY");
    const reverse = screen.getByRole("button", { name: "Reverse" });
    expect(reverse.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(reverse);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect([onReverse, onClear, onOff].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });
});
