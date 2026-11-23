// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mode } from "@/lib/radio-types";
import { fakeIntersectionObserver } from "@/test/fake-intersection-observer";
import { TuningBar } from "./TuningBar";

// Where the bar's sentinel is, as scrolling would report it.
let report: (intersecting: boolean) => void;
beforeEach(() => {
  report = fakeIntersectionObserver();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderBar(props: { mode?: Mode; onMode?: (m: Mode) => void; onChangeReceiver?: () => void } = {}) {
  const watch = createRef<HTMLDivElement>();
  const view = render(
    <main>
      <div ref={watch}>modes</div>
      <button type="button">outside</button>
      <TuningBar
        watch={watch}
        freqKhz={9420}
        mode={props.mode ?? "am"}
        onMode={props.onMode ?? (() => {})}
        busy={false}
        receiverText="Kyiv"
        onChangeReceiver={props.onChangeReceiver ?? (() => {})}
      />
    </main>,
  );
  return view;
}

const bar = () => screen.queryByRole("region", { name: "Tuning bar" });

describe("TuningBar", () => {
  // Value: protects=the bar shows only once the sentinel (page top to the modes) has scrolled past, including a first report after a jump down the page; fails_when=it shows while the sentinel is in view or misses a first not-intersecting report; why_new=no sticky bar before #90; seam=none; no_claim=real scrolling geometry (IntersectionObserver faked; unit only)
  it.each([
    ["sentinel in view: main controls showing", [true], false],
    ["scrolled past the modes", [true, false], true],
    ["scrolled back up", [true, false, true], false],
    ["opened or jumped straight down the page", [false], true],
  ])("%s", (_name, reports, shown) => {
    renderBar();
    expect(bar()).toBeNull();
    for (const r of reports) report(r);
    expect(bar() !== null).toBe(shown);
  });

  // Value: protects=a hidden bar is gone from the accessibility tree and the tab order (hidden attribute), so its Listen and mode buttons never duplicate the page's; fails_when=the bar is hidden by style or inert only; why_new=new component; seam=none; no_claim=what a real screen reader announces (jsdom roles only)
  it("is out of the accessibility tree while hidden, and one labelled region with pressed-state buttons when shown", () => {
    renderBar({ mode: "usb" });
    report(true);
    expect(bar()).toBeNull();
    expect(screen.queryByRole("button", { name: "Listen" })).toBeNull();

    report(false);
    expect(bar()).not.toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "USB" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "AM" }).getAttribute("aria-pressed")).toBe("false");
    expect(bar()!.textContent).toContain("9,420.00 kHz");
  });

  // Value: protects=keyboard focus in the bar keeps it up until focus leaves, but a mouse press does not pin it (D8, D12); fails_when=the bar hides under a keyboard user or stays stuck after a click; why_new=new behavior; seam=none; no_claim=per-browser focus on click (pointerdown simulated)
  it("stays while keyboard focus is inside, and hides once it leaves; a mouse press doesn't hold it", () => {
    renderBar();
    report(false);
    const am = screen.getByRole("button", { name: "AM" });

    fireEvent.focus(am);
    report(true);
    expect(bar()).not.toBeNull();
    fireEvent.blur(am, { relatedTarget: screen.getByRole("button", { name: "outside" }) });
    expect(bar()).toBeNull();

    report(false);
    const usb = screen.getByRole("button", { name: "USB" });
    fireEvent.pointerDown(usb);
    fireEvent.focus(usb);
    fireEvent.pointerUp(usb);
    report(true);
    expect(bar()).toBeNull();
  });

  // Value: protects=a press that focuses nothing (Safari's buttons, the bar's padding) doesn't make the next keyboard focus look like a pointer's, and a click while keyboard focus holds the bar doesn't hide it from under the pointer; fails_when=the pointer flag outlives its press, or a pointer focus switches the keyboard hold off; why_new=bugs found in review of the first version; seam=none; no_claim=real browser event order (synthetic events)
  it("keeps the keyboard hold right around presses that focus nothing, and through a click while held", () => {
    renderBar();
    report(false);
    const am = screen.getByRole("button", { name: "AM" });
    const usb = screen.getByRole("button", { name: "USB" });

    // Safari: the press focuses nothing; the Tab after it is the keyboard's.
    fireEvent.pointerDown(usb);
    fireEvent.pointerUp(usb);
    fireEvent.focus(am);
    report(true);
    expect(bar()).not.toBeNull();

    // Held by keyboard focus, a click on another bar button keeps the bar up.
    fireEvent.pointerDown(usb);
    fireEvent.blur(am, { relatedTarget: usb });
    fireEvent.focus(usb);
    expect(bar()).not.toBeNull();
    fireEvent.pointerUp(usb);
    fireEvent.blur(usb, { relatedTarget: screen.getByRole("button", { name: "outside" }) });
    expect(bar()).toBeNull();
  });

  // Value: protects=a touch that turns into a scroll (pointercancel, no pointerup) doesn't make the next keyboard focus look like a pointer's, so the bar still holds under a keyboard user; fails_when=only pointerup clears the pointer flag; why_new=the test above covers pointerup only; seam=none; no_claim=which browsers send pointercancel on a scroll (synthetic events)
  it("keeps the keyboard hold after a touch that was cancelled by a scroll", () => {
    renderBar();
    report(false);
    const usb = screen.getByRole("button", { name: "USB" });
    fireEvent.pointerDown(usb);
    fireEvent.pointerCancel(usb);
    fireEvent.focus(screen.getByRole("button", { name: "AM" }));
    report(true);
    expect(bar()).not.toBeNull();
  });

  // Value: protects=the bar's buttons act through the page's callbacks, and the receiver button's name starts with the text it shows (WCAG 2.5.3); fails_when=a button keeps its own state or the name drops the visible text; why_new=new component; seam=none; no_claim=the page's handlers (callbacks mocked)
  it("passes mode and receiver presses to the page, the receiver named by what it shows", () => {
    const onMode = vi.fn();
    const onChangeReceiver = vi.fn();
    renderBar({ onMode, onChangeReceiver });
    report(false);
    fireEvent.click(screen.getByRole("button", { name: "CW" }));
    expect(onMode).toHaveBeenCalledWith("cw");
    fireEvent.click(screen.getByRole("button", { name: "Kyiv, change receiver" }));
    expect(onChangeReceiver).toHaveBeenCalledTimes(1);
  });

  // Value: protects=the bar starts watching once the watched element exists, even if it renders after the bar; fails_when=the observer setup runs only at mount and gives up on a missing element; why_new=review found the bar would silently never show; seam=none; no_claim=none beyond protects
  it("starts watching once the watched element appears", () => {
    const watch = createRef<HTMLDivElement>();
    const ui = (withModes: boolean) => (
      <main>
        {withModes && <div ref={watch}>modes</div>}
        <TuningBar
          watch={watch}
          freqKhz={9420}
          mode="am"
          onMode={() => {}}
          busy={false}
          receiverText="Kyiv"
          onChangeReceiver={() => {}}
        />
      </main>
    );
    const view = render(ui(false));
    expect(() => report(false)).toThrow("no IntersectionObserver was made");
    view.rerender(ui(true));
    report(false);
    expect(bar()).not.toBeNull();
  });

  // Value: protects=a browser without IntersectionObserver keeps today's page (no bar, no error); fails_when=the bar constructs an observer unguarded; why_new=new dependency on IntersectionObserver; seam=none; no_claim=none beyond protects
  it("never shows without IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    renderBar();
    expect(() => report(false)).toThrow("no IntersectionObserver was made");
    expect(bar()).toBeNull();
  });
});
