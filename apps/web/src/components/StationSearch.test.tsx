// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Broadcast } from "@/lib/eibi";
import { PHONE_ROWS } from "./SignalList";
import { ANNOUNCE_DELAY_MS, PAGE_ROWS, type SearchSchedule, StationSearch } from "./StationSearch";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Thursday 19 November 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 19, 12, 0);

const b = (station: string, khz: number, start: number, end: number, more: Partial<Broadcast> = {}): Broadcast => ({
  khz,
  start,
  end,
  days: "",
  station,
  lang: "E",
  target: "Eu",
  ...more,
});

const SCHEDULE: SearchSchedule = {
  season: "b26",
  targetNames: { Eu: "Europe", SAs: "South Asia", ENA: "Eastern North America" },
  broadcasts: [
    b("BBC", 9410, 660, 780), // on now
    b("BBC", 12095, 660, 780, { target: "SAs" }),
    b("BBC", 12095, 660, 780, { target: "ENA" }),
    b("BBC", 6195, 1080, 1140), // 18:00
    b("Shannon Volmet", 8957, 660, 780, { target: "" }),
    b("NHK Radio Japan", 9750, 0, 60, { days: "Sa" }),
    b("NHK World", 6000, 0, 60, { days: "Sa" }),
  ],
};

type Props = Parameters<typeof StationSearch>[0];

function show(over: Partial<Props> = {}) {
  const props: Props = {
    schedule: SCHEDULE,
    loadFailed: false,
    onRetry: vi.fn(),
    clock: NOW,
    freqKhz: 9410,
    strong: null,
    idle: false,
    onTune: vi.fn(),
    onPickBest: vi.fn(),
    ...over,
  };
  const view = render(<StationSearch {...props} />);
  const field = screen.getByLabelText("Station name") as HTMLInputElement;
  const type = (text: string) => fireEvent.change(field, { target: { value: text } });
  const announced = () => view.container.querySelector(".visually-hidden[role=status]")!.textContent!.trim();
  const rerender = (more: Partial<Props>) => view.rerender(<StationSearch {...props} {...more} />);
  return { props, field, type, announced, rerender, view };
}

/** The visible status line (not live; the hidden live region repeats it). */
const statusLine = () => document.querySelector(".station-search-status")!.textContent;

const rowNames = () => screen.queryAllByRole("button", { name: /kHz/ }).map((r) => r.getAttribute("aria-label"));

describe("StationSearch", () => {
  // Value: protects=every state before results says what's happening: loading (field off), a failed load with Try again (outside the live region) that keeps typed text, and the empty field's hint; fails_when=a failed load says "Loading" forever, retry is missing, or the empty section is blank; why_new=design review 3A, 5A and the eng re-check error state; seam=none; no_claim=react-query's retry timing
  it("says what's happening before there are results", () => {
    const loading = show({ schedule: undefined });
    expect(loading.field.disabled).toBe(true);
    expect(statusLine()).toBe("Loading the schedule…");
    cleanup();
    const failed = show({ schedule: undefined, loadFailed: true });
    expect(statusLine()).toBe("Couldn't load the station schedule.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(failed.props.onRetry).toHaveBeenCalledTimes(1);
    cleanup();
    show();
    expect(statusLine()).toBe("Type part of a station's name, like BBC or Nacional.");
    expect(rowNames()).toEqual([]);
  });

  // Value: protects=an empty result says why: no name matched (quoting the query) versus one or several stations not scheduled in the next 24 hours; fails_when=a correctly typed station that's off today gets the spelling hint; why_new=design review 4A; seam=none; no_claim=none beyond protects
  it("tells a spelling miss from a station that's off", () => {
    const { type } = show();
    type("zzz");
    expect(statusLine()).toBe("No station named “zzz” in this season's schedule. Try part of the name.");
    type("radio japan");
    expect(statusLine()).toBe("NHK Radio Japan isn't scheduled in the next 24 hours.");
    type("nhk");
    expect(statusLine()).toBe("None of the 2 matching stations are scheduled in the next 24 hours.");
  });

  // Value: protects=rows read and speak as designed: the totals line, on-now rows first, a later row's time and wait, every target name joined, the mode only off AM, "Strong here" only on an on-now row this receiver's scan heard within 0.5 kHz, the tuned row as aria-current, and a click tuning in the row's mode; fails_when=a target is dropped, Strong shows on a later row or another frequency, a USB row says nothing, the tuned row is colour-only, or a click tunes AM everywhere; why_new=station search D1, D2, D11, design 2A, 7A, 8A, 9A, 14A, 15B, re-check D4; seam=none; no_claim=visual layout
  it("lists broadcasts with their time, targets, mode and Strong tag", () => {
    const { type, props } = show({
      strong: [
        { freqKhz: 12095.3, snrDb: 30, band: "25m" },
        { freqKhz: 6195, snrDb: 25, band: "49m" },
      ],
    });
    type("bbc volmet");
    expect(rowNames()).toEqual([]);
    type("bbc");
    expect(statusLine()).toBe("3 broadcasts: 2 on now, 1 later in the next 24 hours.");
    expect(rowNames()).toEqual([
      "9,410 kHz, BBC, English, on now, to Europe",
      "12,095 kHz, BBC, English, on now, to South Asia, Eastern North America, strong here",
      "6,195 kHz, BBC, English, starts 18:00 UTC, in 6 h, to Europe",
    ]);
    expect(screen.getByRole("button", { name: /^9,410 kHz/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /^12,095 kHz/ }).getAttribute("aria-current")).toBeNull();
    expect(screen.getAllByText("Strong here")).toHaveLength(1);
    type("volmet");
    expect(rowNames()).toEqual(["8,957 kHz USB, Shannon Volmet, English, on now"]);
    fireEvent.click(screen.getByRole("button", { name: /^8,957 kHz/ }));
    expect(props.onTune).toHaveBeenCalledWith(8957, "usb");
    type("bbc");
    fireEvent.click(screen.getByRole("button", { name: /^12,095 kHz/ }));
    expect(props.onTune).toHaveBeenLastCalledWith(12095, "am");
  });

  // Value: protects=Escape empties the field and its results in every browser, back to the hint; fails_when=the Escape handler is dropped or checks the wrong key, so browsers that don't clear a search field on Escape keep the old results; why_new=StationSearch's onKeyDown had no test (/ship coverage audit); seam=none; no_claim=the browser's own clearing of type=search fields
  it("clears the search on Escape", () => {
    const { type, field } = show();
    type("bbc");
    expect(rowNames()).toHaveLength(3);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
    expect(rowNames()).toEqual([]);
    expect(statusLine()).toBe("Type part of a station's name, like BBC or Nacional.");
  });

  // Value: protects=a schedule cached from a server older than this deploy (no targetNames) still lists rows, just without a "to" line; fails_when=the list crashes on deploy skew; why_new=station search build review (correctness reviewer); seam=none; no_claim=react-query's cache lifetime
  it("lists rows from a schedule without target names", () => {
    const old = { ...SCHEDULE, targetNames: undefined } as unknown as SearchSchedule;
    const { type } = show({ schedule: old });
    type("bbc");
    expect(rowNames()[0]).toBe("9,410 kHz, BBC, English, on now");
  });

  // Value: protects=after a click the note says why there may be no sound: nothing playing (with Pick best for the dial), out of the receiver's range (same button), or when a later broadcast starts, in a click-only live region, and an idle note goes once a receiver plays, and a later click on an on-now row the receiver reaches clears the note; fails_when=a click with nothing playing is silent, Pick best is missing or wired wrong, or a stale note lingers (a "starts at" note left under an on-now row); why_new=station search D10, design 6B/7A, re-check D6; on-now clearing added by the /ship coverage audit; seam=none; no_claim=screen reader timing
  it("explains a click that may play nothing", () => {
    const { type, props, rerender } = show({ idle: true, freqKhz: 6195 });
    type("bbc");
    fireEvent.click(screen.getByRole("button", { name: /^6,195 kHz/ }));
    expect(screen.getByText("Nothing is playing.").getAttribute("role")).toBe("status");
    fireEvent.click(screen.getByRole("button", { name: "Pick best for 6,195 kHz" }));
    expect(props.onPickBest).toHaveBeenCalledTimes(1);
    rerender({ idle: false });
    expect(screen.queryByText("Nothing is playing.")).toBeNull();
    rerender({ idle: false, reaches: (khz) => khz < 10_000 });
    fireEvent.click(screen.getByRole("button", { name: /^12,095 kHz/ }));
    expect(screen.getByText("This receiver doesn't reach 12,095 kHz.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Pick best for/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^6,195 kHz/ }));
    expect(screen.getByText("BBC · English starts at 18:00 UTC, in 6 h.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Pick best for/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^9,410 kHz/ }));
    expect(document.querySelector(".station-search-note [role=status]")!.textContent).toBe("");
  });

  // Value: protects=long results page in 20s with a counting button ("Show 20 more of R", then "Show the last R"), focus moving to the first new row, each page read out at once ("Showing 40 of 45."), rows past 8 marked for the phone's first page with its own reveal that moves focus to the ninth row and goes away, and a new query starting over; fails_when=rows past 20 are unreachable, focus is lost after either Show more, a screen reader hears nothing after paging or a wrong count, the phone sees all 20 at once, or a new search keeps the old page count; why_new=station search D5, design 2A, 11A, 12A, 13A; phone reveal and paging announcement added by the /ship coverage audit; seam=none; no_claim=the 520px CSS hiding (jsdom applies no media queries)
  it("pages long results", () => {
    const many: SearchSchedule = {
      ...SCHEDULE,
      broadcasts: Array.from({ length: 45 }, (_, i) => b("Many Radio", 5900 + i * 5, 660, 780)),
    };
    const { type, announced } = show({ schedule: many, freqKhz: 1 });
    type("many");
    expect(rowNames()).toHaveLength(PAGE_ROWS);
    const items = document.querySelectorAll(".station-results li");
    expect(items[PHONE_ROWS - 1]!.hasAttribute("data-beyond")).toBe(false);
    expect(items[PHONE_ROWS]!.hasAttribute("data-beyond")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: `Show ${PAGE_ROWS - PHONE_ROWS} more` }));
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^5,940 kHz/);
    expect(screen.queryByRole("button", { name: `Show ${PAGE_ROWS - PHONE_ROWS} more` })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 20 more of 25" }));
    expect(rowNames()).toHaveLength(40);
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^6,000 kHz/);
    expect(announced()).toBe("Showing 40 of 45.");
    fireEvent.click(screen.getByRole("button", { name: "Show the last 5" }));
    expect(rowNames()).toHaveLength(45);
    expect(announced()).toBe("Showing 45 of 45.");
    expect(screen.queryByRole("button", { name: /^Show / })).toBeNull();
    type("many radio");
    expect(rowNames()).toHaveLength(PAGE_ROWS);
  });

  // Value: protects=screen readers hear the count once typing pauses for 500 ms, not per keystroke; a load or Show more is read at once and cancels a count still waiting; a minute going by never adds an announcement; the same count is read again after a retype; fails_when=each keystroke is read over the typist, a late count overwrites a newer message, the minute clock chatters, or a retyped query is met with silence; why_new=design 13A, eng re-check C3/C6/C8; seam=fake timers; no_claim=real screen reader behaviour
  it("reads the count out once typing pauses", () => {
    vi.useFakeTimers();
    const { type, announced, rerender } = show({ schedule: undefined });
    expect(announced()).toBe("");
    rerender({ schedule: SCHEDULE });
    expect(announced()).toBe("Type part of a station's name, like BBC or Nacional.");
    type("b");
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS - 100));
    type("bb");
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS - 100));
    expect(announced()).toBe("Type part of a station's name, like BBC or Nacional.");
    type("bbc");
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS));
    expect(announced()).toBe("3 broadcasts: 2 on now, 1 later in the next 24 hours.");
    rerender({ schedule: SCHEDULE, clock: NOW + 7 * 60 * 60_000 });
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS * 2));
    expect(announced()).toBe("3 broadcasts: 2 on now, 1 later in the next 24 hours.");
    // The same words announced again still change the region, so they're read again.
    const raw = () => document.querySelector(".visually-hidden[role=status]")!.textContent;
    rerender({ schedule: SCHEDULE });
    const before = raw();
    type("");
    type("bbc");
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS));
    expect(raw()).not.toBe(before);
    expect(announced()).toBe("3 broadcasts: 2 on now, 1 later in the next 24 hours.");
  });
});
