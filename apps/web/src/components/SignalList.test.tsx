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
    <SignalList scan={scan} canScan listening freqKhz={9_420} onTune={() => {}} onScanAgain={onScanAgain} {...over} />,
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

  // Value: protects=each scan state says what's happening in the live region, and a failure offers Scan again (D5); fails_when=a state renders nothing or the error has no way to retry; why_new=new component; seam=none; no_claim=screen reader timing
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
  ])("says so %s", (_, scan, text) => {
    const { onScanAgain } = show(scan);
    expect(screen.getByRole("status").textContent).toContain(text);
    const again = screen.queryByRole("button", { name: "Scan again" });
    if (scan?.state === "error" || scan?.state === "done") {
      fireEvent.click(again!);
      expect(onScanAgain).toHaveBeenCalledTimes(1);
    } else {
      expect(again).toBeNull();
    }
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
