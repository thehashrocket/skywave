// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HamDone, HamPhase, ScanState } from "@/lib/use-radio";
import { HAM_STALE_MS, PHONE_ROWS, SignalList, phoneShown } from "./SignalList";

afterEach(cleanup);

const at = { id: 1, host: "kiwi.example", port: 8073 };

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
    const done = (id = 1): ScanState => ({
      state: "done",
      ...at,
      id,
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
    fireEvent.click(screen.getByRole("button", { name: `Show all ${signals.length} broadcast` }));
    expect(list().classList.contains("signals-list-all")).toBe(true);
    expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
    // The button went away; focus lands on the first row it revealed.
    expect(document.activeElement).toBe(list().querySelectorAll(".preset-tune")[8]);
    const again = (scan: ScanState) =>
      view.rerender(
        <SignalList
          scan={scan}
          canScan
          listening
          freqKhz={9_420}
          scanDelayMs={10_000}
          checking={false}
          onTune={() => {}}
          onScanAgain={() => {}}
        />,
      );
    // The second reply of the same request (its amateur part) keeps it open (design D14)...
    again(done(1));
    expect(list().classList.contains("signals-list-all")).toBe(true);
    // ...and a new request starts short again.
    again(done(2));
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

  describe("amateur bands", () => {
    const broadcast = (ham?: HamPhase, id = 1): ScanState => ({
      state: "done",
      ...at,
      id,
      signals: [{ freqKhz: 9_420, snrDb: 41, band: "31m" }],
      hidden: 0,
      bandsDone: 15,
      bandsTotal: 15,
      partial: false,
      ...(ham && { ham }),
    });
    const amateur = (over: Partial<HamDone> = {}): HamDone => ({
      ...at,
      voice: [{ freqKhz: 14_251.3, snrDb: 24, band: "20m", mode: "usb" }],
      cw: [{ freqKhz: 14_025.4, snrDb: 22, band: "20m", mode: "cw" }],
      digital: [
        { freqKhz: 14_074, snrDb: 27, band: "20m", mode: "usb", label: "FT8" },
        { freqKhz: 7_047.5, snrDb: 14, band: "40m", mode: "usb", label: "FT4" },
      ],
      bandsDone: 9,
      bandsTotal: 9,
      partial: false,
      heardAtMs: Date.now(),
      ...over,
    });
    const status = () => screen.getByRole("status").textContent ?? "";

    // Value: protects=each amateur state says what's happening under the Amateur heading and in one short live summary (design D5, D13); fails_when=a state renders nothing, reads as silence, or the summary repeats the lists; why_new=amateur scan; seam=none; no_claim=screen reader timing
    it.each<[string, HamPhase, HamDone | null, string, string]>([
      ["scanning", "scanning", null, "Scanning the amateur bands…", "1 broadcast signal. Scanning the amateur bands…"],
      [
        "failed",
        "error",
        null,
        "Couldn't scan the amateur bands.",
        "1 broadcast signal. Couldn't scan the amateur bands.",
      ],
      [
        "with nothing found",
        "done",
        amateur({ voice: [], cw: [], digital: [] }),
        "No strong amateur signals right now.",
        "No strong amateur signals right now.",
      ],
      [
        "outside the amateur bands",
        "done",
        amateur({ voice: [], cw: [], digital: [], bandsDone: 0, bandsTotal: 0 }),
        "This receiver doesn't cover the amateur bands.",
        "This receiver doesn't cover the amateur bands.",
      ],
      [
        "partly scanned",
        "done",
        amateur({ bandsDone: 6, partial: true }),
        "Scanned 6 of 9 amateur bands.",
        "Amateur: 1 voice, 1 CW, 2 digital.",
      ],
    ])("says so when %s", (_, phase, ham, note, summary) => {
      const view = render(
        <SignalList
          scan={broadcast(phase)}
          lastHam={ham}
          canScan
          canScanHam
          listening
          freqKhz={9_420}
          scanDelayMs={10_000}
          checking={false}
          onTune={() => {}}
          onScanAgain={() => {}}
        />,
      );
      const section = view.container.querySelector(".signals-ham")!;
      expect(section.textContent).toContain(note);
      expect(status()).toContain(summary);
      // Space is held while scanning, so the rows below don't jump when results land.
      expect(section.querySelector("[data-scanning]") !== null).toBe(phase === "scanning");
      expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent?.replace(/Just now.*/, ""))).toEqual(
        ["Broadcast", "Amateur"],
      );
    });

    // Value: protects=amateur rows show kHz to 0.1 (digital at their standard dial), a "<band> <mode>" tag, group notes, and tune in their own mode, CW at the signal itself (the service adds the pitch) (design D4, D10, D16 corrected); fails_when=rows tune AM, CW is offset twice, or MHz labels return; why_new=amateur rows; seam=none; no_claim=what the tones sound like
    it("lists amateur rows by group and tunes each in its mode", () => {
      const onTune = vi.fn();
      show(broadcast("done"), { canScanHam: true, lastHam: amateur(), onTune });
      expect(screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual([
        "Voice",
        "CW",
        "Digital",
      ]);
      expect(screen.getByText("Morse code.")).toBeTruthy();
      expect(screen.getByText(/skywave doesn't decode them/)).toBeTruthy();
      expect(screen.getByText(/Hams use far less power than broadcasters/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /14,251\.3\s*20m USB/ }));
      fireEvent.click(screen.getByRole("button", { name: /14,025\.4\s*20m CW/ }));
      fireEvent.click(screen.getByRole("button", { name: /14,074\s*20m FT8/ }));
      fireEvent.click(screen.getByRole("button", { name: /7,047\.5\s*40m FT4/ }));
      fireEvent.click(screen.getByRole("button", { name: /9,420\s*31m/ }));
      expect(onTune.mock.calls).toEqual([
        [14_251.3, "usb"],
        [14_025.4, "cw"],
        [14_074, "usb"],
        [7_047.5, "usb"],
        [9_420, "am"],
      ]);
    });

    // Value: protects=a row is tuned only in its frequency AND mode, and says so in words and aria-current, not just amber (design D15); fails_when=the mode check or the label goes; why_new=amateur rows share frequencies across modes; seam=none; no_claim=styling
    it("marks a row tuned only in its own mode, in words too", () => {
      show(broadcast("done"), { canScanHam: true, lastHam: amateur(), freqKhz: 14_251.3, mode: "lsb" });
      expect(screen.queryByText(/^Tuned/)).toBeNull();
      cleanup();
      show(broadcast("done"), { canScanHam: true, lastHam: amateur(), freqKhz: 14_251.3, mode: "usb" });
      const tuned = screen.getByRole("button", { name: /14,251\.3/ });
      expect(tuned.getAttribute("aria-current")).toBe("true");
      expect(tuned.textContent).toContain("Tuned · 24 dB above noise");
      expect(screen.getByRole("button", { name: /9,420/ }).hasAttribute("aria-current")).toBe(false);
    });

    // Value: protects=the amateur list shows its age from the sweep time, says "may be out of date" from 2 min (muted, data-old) and announces only that change, never the ticking age (design D8, D13); fails_when=the age sits in the live region, starts from receipt, or the stale mark never appears; why_new=amateur freshness; seam=none; no_claim=real clock drift
    it("ages the amateur list outside the live region", () => {
      vi.useFakeTimers({ now: 10_000_000 });
      try {
        const view = render(
          <SignalList
            scan={broadcast("done")}
            lastHam={amateur({ heardAtMs: 10_000_000 - 30_000 })}
            canScan
            canScanHam
            listening
            freqKhz={9_420}
            scanDelayMs={10_000}
            checking={false}
            onTune={() => {}}
            onScanAgain={() => {}}
          />,
        );
        const age = () => view.container.querySelector(".signals-age")!;
        expect(age().textContent).toBe("Just now");
        expect(screen.getByRole("status").contains(age())).toBe(false);
        act(() => vi.advanceTimersByTime(60_000));
        expect(age().textContent).toBe("Heard 1 min ago");
        expect(status()).not.toContain("out of date");
        act(() => vi.advanceTimersByTime(HAM_STALE_MS - 90_000));
        expect(age().textContent).toBe("Heard 2 min ago · may be out of date");
        expect(age().hasAttribute("data-old")).toBe(true);
        expect(status()).toContain("Amateur list may be out of date.");
      } finally {
        vi.useRealTimers();
      }
    });

    // Value: protects=the old amateur list (and its age) stays through a refresh while Scan again waits for both passes (design D6, D8); fails_when=the list vanishes on refresh or Scan again re-enables after the broadcast reply; why_new=two-step replies; seam=none; no_claim=none beyond protects
    it("keeps the last amateur list through a refresh and waits for both passes", () => {
      const { onScanAgain } = show(broadcast("scanning", 2), { canScanHam: true, lastHam: amateur() });
      expect(screen.getByRole("button", { name: /14,251\.3/ })).toBeTruthy();
      expect(screen.getByText("Scanning the amateur bands…")).toBeTruthy();
      const again = screen.getByRole("button", { name: "Scan again" });
      expect(again.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(again);
      expect(onScanAgain).not.toHaveBeenCalled();
    });

    // Value: protects=a failed amateur refresh keeps the last list and its age, and says the refresh failed under the heading and in the summary (design D5, D8); fails_when=the error state hides the kept rows or drops the error line; why_new=review gap; seam=none; no_claim=none beyond protects
    it("keeps the last amateur list when a refresh fails", () => {
      show(broadcast("error", 2), { canScanHam: true, lastHam: amateur() });
      expect(screen.getByRole("button", { name: /14,251\.3/ })).toBeTruthy();
      expect(document.querySelector(".signals-ham")!.textContent).toContain("Couldn't scan the amateur bands.");
      expect(status()).toContain("Couldn't scan the amateur bands.");
      expect(screen.getByRole("button", { name: "Scan again" }).hasAttribute("aria-disabled")).toBe(false);
    });

    // Value: protects=a phone finds the amateur rows: the status line links to them once they land, outside the live region (design D9); fails_when=the link is missing, points elsewhere, or is announced; why_new=amateur section sits below broadcast; seam=none; no_claim=scroll behavior
    it("links to the amateur rows from the status line", () => {
      show(broadcast("done"), { canScanHam: true, lastHam: amateur() });
      const link = screen.getByRole("link", { name: "Amateur: 4 found below" });
      expect(link.getAttribute("href")).toBe("#signals-amateur");
      expect(document.getElementById("signals-amateur")?.tagName).toBe("H3");
      expect(screen.getByRole("status").contains(link)).toBe(false);
    });

    // Value: protects=phones share 8 amateur rows Voice 4 / CW 2 / Digital 2, giving unused rows to the others in order (design D12); fails_when=the split or the reallocation changes; why_new=grouped amateur rows; seam=none; no_claim=CSS hiding (browser check)
    it.each([
      [
        [10, 5, 5],
        [4, 2, 2],
      ],
      [
        [10, 0, 0],
        [8, 0, 0],
      ],
      [
        [1, 1, 10],
        [1, 1, 6],
      ],
      [
        [2, 9, 0],
        [2, 6, 0],
      ],
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
    ])("shows %j amateur rows on a phone as %j", (counts, shown) => {
      expect(phoneShown(counts)).toEqual(shown);
    });

    // Value: protects=on a phone the amateur Show all names its section, reveals every group (a group with no rows in the preview hides whole), focuses the first row it revealed there, and is not undone by the next reply of the same result (design D12, D14); fails_when=one Show all opens both sections, focus lands in Broadcast, or a hidden group keeps its heading; why_new=two sections; seam=none; no_claim=CSS hiding (browser check)
    it("reveals the whole amateur section on its own", () => {
      const voice = Array.from({ length: 9 }, (_, i) => ({
        freqKhz: 14_200 + i * 5,
        snrDb: 30 - i,
        band: "20m",
        mode: "usb" as const,
      }));
      const ham = amateur({
        voice,
        cw: [],
        digital: [{ freqKhz: 14_074, snrDb: 27, band: "20m", mode: "usb", label: "FT8" }],
      });
      const view = render(
        <SignalList
          scan={broadcast("done")}
          lastHam={ham}
          canScan
          canScanHam
          listening
          freqKhz={9_420}
          scanDelayMs={10_000}
          checking={false}
          onTune={() => {}}
          onScanAgain={() => {}}
        />,
      );
      const section = view.container.querySelector(".signals-ham")!;
      // 9 voice + 1 digital: voice 4 + digital 1, then 3 spare to voice: 7 voice, 1 digital shown.
      expect(section.querySelectorAll("li[data-beyond]").length).toBe(2);
      fireEvent.click(screen.getByRole("button", { name: "Show all 10 amateur" }));
      expect(section.hasAttribute("data-all")).toBe(true);
      expect(document.activeElement).toBe(section.querySelector("li[data-beyond] .preset-tune"));
      expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
    });

    // Value: protects=a service with amateur scanning names both bands in the waiting note; an older one keeps today's wording and layout (design D7); fails_when=the variants swap or headings appear for an older service; why_new=amateur scan; seam=none; no_claim=none beyond protects
    it("names the amateur bands only for a service that scans them", () => {
      show(null, { canScanHam: true });
      expect(status()).toContain("The broadcast and amateur bands get scanned about 10 seconds after");
      cleanup();
      show(broadcast(), {});
      expect(status()).toContain("Strongest first, in AM.");
      expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    });
  });
});
