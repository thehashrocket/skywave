// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScanState } from "@/lib/use-radio";
import { PHONE_ROWS, SignalList } from "./SignalList";

afterEach(cleanup);

const at = { host: "kiwi.example", port: 8073 };

function show(scan: ScanState | null, over: Partial<Parameters<typeof SignalList>[0]> = {}) {
  const onScanAgain = vi.fn();
  render(
    <SignalList
      scan={scan}
      canScan
      listening
      freqKhz={9_420}
      scanDelayMs={10_000}
      checking={false}
      onTune={() => {}}
      onScanAgain={onScanAgain}
      {...over}
    />,
  );
  return { onScanAgain };
}

describe("SignalList", () => {
  // Value: protects=the list is absent for an older service and before anything plays; fails_when=it renders an empty section or a dead Scan again; why_new=new component (D13); seam=none; no_claim=none beyond protects
  it("stays hidden without scan support or a receiver", () => {
    show(null, { canScan: false });
    show(null, { listening: false });
    expect(screen.queryByRole("heading")).toBeNull();
  });

  // Value: protects=each scan state says what's happening in the live region, Scan again stays outside it, works after a scan and is inert during one (D5, review D5); fails_when=a state renders nothing or the error has no way to retry; why_new=new component; seam=none; no_claim=screen reader timing
  it.each<[string, ScanState | null, string]>([
    ["before the first scan", null, "scanned about 10 seconds after"],
    ["scanning", { state: "scanning", ...at }, "Scanning this receiver's broadcast bands"],
    [
      "failed",
      { state: "error", ...at, message: "Couldn't scan this receiver: full." },
      "Couldn't scan this receiver: full.",
    ],
    [
      "empty",
      { state: "done", ...at, signals: [], hidden: 0, bandsDone: 15, bandsTotal: 15, partial: false },
      "No strong broadcast signals right now.",
    ],
    // Value: protects=a receiver outside every broadcast band says so instead of reporting quiet bands (eng review D15); fails_when=bandsTotal 0 falls through to the empty-list text; why_new=plan audit found it missing; seam=none; no_claim=which listed receivers are shifted
    [
      "outside the broadcast bands",
      { state: "done", ...at, signals: [], hidden: 0, bandsDone: 0, bandsTotal: 0, partial: false },
      "This receiver doesn't cover the broadcast bands.",
    ],
  ])("says so %s", (_, scan, text) => {
    const { onScanAgain } = show(scan);
    expect(screen.getByRole("status").textContent).toContain(text);
    const again = screen.queryByRole("button", { name: "Scan again" });
    // Only the text is announced: the button sits outside the live region.
    expect(screen.getByRole("status").contains(again)).toBe(false);
    if (scan?.state === "error" || scan?.state === "done") {
      fireEvent.click(again!);
      expect(onScanAgain).toHaveBeenCalledTimes(1);
    } else if (scan?.state === "scanning") {
      // Stays in place (and focusable) while its scan runs, but does nothing.
      expect(again!.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(again!);
      expect(onScanAgain).not.toHaveBeenCalled();
    } else {
      expect(again).toBeNull();
    }
  });

  // Value: protects=Scan again does nothing once the receiver stops playing, while still showing the last list; fails_when=the busy guard ignores listening, so a click sends a scan with no receiver; why_new=review (disabled state); seam=none; no_claim=styling of the dimmed button
  it("keeps Scan again inert when nothing is playing", () => {
    const { onScanAgain } = show(
      { state: "done", ...at, signals: [], hidden: 0, bandsDone: 15, bandsTotal: 15, partial: false },
      { listening: false },
    );
    const again = screen.getByRole("button", { name: "Scan again" });
    expect(again.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(again);
    expect(onScanAgain).not.toHaveBeenCalled();
  });

  // Value: protects=the waiting note states the page's real auto-scan delay; fails_when=the note hardcodes 10 seconds again; why_new=cycle-2 testing review (only 10_000 was tested); seam=none; no_claim=page wiring of AUTO_SCAN_MS (page.test)
  it("says how long until the scan from the delay it's given", () => {
    show(null, { scanDelayMs: 5_000 });
    expect(screen.getByRole("status").textContent).toContain("about 5 seconds");
  });

  // Value: protects=the signal being listened to is marked like a current preset; fails_when=data-current is dropped; why_new=new component; seam=none; no_claim=styling
  it("marks the signal that's tuned", () => {
    show({
      state: "done",
      ...at,
      signals: [
        { freqKhz: 9_420, snrDb: 30, band: "31m" },
        { freqKhz: 11_650, snrDb: 25, band: "25m" },
      ],
      hidden: 0,
      bandsDone: 15,
      bandsTotal: 15,
      partial: false,
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.hasAttribute("data-current"))).toEqual([true, false]);
  });

  // Value: protects=the waiting text names the real wait after Pick best (its 15 s check, then 10 s) (eng review R11); fails_when=checking isn't read or the texts swap; why_new=only the 10 s text existed; seam=none; no_claim=the scan timing itself (page.test.tsx)
  it("says the scan waits for Pick best's check while it runs", () => {
    show(null, { checking: true, scanDelayMs: 25_000 });
    expect(screen.getByRole("status").textContent).toMatch(
      /once Pick best has finished checking this receiver, about 25 seconds in/,
    );
  });

  // Value: protects=a long scan offers "Show all" for phones and a new scan starts short again (eng review R9); fails_when=the button shows for a short list, doesn't expand, or the expansion sticks to the next scan; why_new=the list had no length behavior; seam=none; no_claim=which rows a phone hides (CSS, browser check)
  it("offers the whole of a long scan, once per scan", () => {
    const signals = Array.from({ length: PHONE_ROWS + 4 }, (_, i) => ({
      freqKhz: 5_900 + i * 5,
      snrDb: 40 - i,
      band: "49m",
    }));
    const done = (): ScanState => ({
      state: "done",
      ...at,
      signals,
      hidden: 0,
      bandsDone: 15,
      bandsTotal: 15,
      partial: false,
    });
    const first = done();
    const view = render(
      <SignalList
        scan={first}
        canScan
        listening
        freqKhz={9_420}
        scanDelayMs={10_000}
        checking={false}
        onTune={() => {}}
        onScanAgain={() => {}}
      />,
    );
    const list = () => view.container.querySelector(".signals-list")!;
    expect(list().classList.contains("signals-list-all")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: `Show all ${signals.length}` }));
    expect(list().classList.contains("signals-list-all")).toBe(true);
    expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
    // The button went away; focus lands on the first row it revealed.
    expect(document.activeElement).toBe(list().querySelectorAll(".preset-tune")[8]);
    view.rerender(
      <SignalList
        scan={done()}
        canScan
        listening
        freqKhz={9_420}
        scanDelayMs={10_000}
        checking={false}
        onTune={() => {}}
        onScanAgain={() => {}}
      />,
    );
    expect(list().classList.contains("signals-list-all")).toBe(false);
    cleanup();
    show({
      state: "done",
      ...at,
      signals: signals.slice(0, PHONE_ROWS),
      hidden: 0,
      bandsDone: 15,
      bandsTotal: 15,
      partial: false,
    });
    expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
  });
});
