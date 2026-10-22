// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScanState } from "@/lib/use-radio";
import { SignalList } from "./SignalList";

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
      autoScanMs={10_000}
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
    show(null, { autoScanMs: 5_000 });
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
});
