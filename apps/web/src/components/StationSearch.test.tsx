// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Broadcast } from "@/lib/eibi";
import { PHONE_ROWS } from "./SignalList";
import { ANNOUNCE_DELAY_MS, FILTERS_KEY, PAGE_ROWS, type SearchSchedule, StationSearch } from "./StationSearch";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
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

/** What an empty field says over SCHEDULE at NOW. */
const BROWSE = "3 broadcasts on now, broadcast bands first. Type a name to find one station.";

const areaSelect = () => screen.getByLabelText("Aimed at") as HTMLSelectElement;
const pickArea = (value: string) => fireEvent.change(areaSelect(), { target: { value } });
const languagesButton = () => screen.getByRole("button", { name: "Languages" });
const panelOptions = () => [...document.querySelectorAll(".language-option")].map((l) => l.textContent);

/** Shows the section and picks an area, for tests that only need the save. */
function pickAreaAfterShow(value: string) {
  show();
  pickArea(value);
}

/** The visible status line (not live; the hidden live region repeats it). */
const statusLine = () => document.querySelector(".station-search-status")!.textContent;

const rowNames = () => screen.queryAllByRole("button", { name: /kHz/ }).map((r) => r.getAttribute("aria-label"));

describe("StationSearch", () => {
  // Value: protects=every state before results says what's happening: loading (field off) until both the schedule and the page's clock are in, a failed load with Try again (outside the live region) that keeps typed text, and the empty field's hint; fails_when=a failed load says "Loading" forever, retry is missing, the empty section is blank, or the field opens before the clock is set (results worked out for 1970); why_new=design review 3A, 5A and the eng re-check error state; clock-null case added by the /ship coverage audit; seam=none; no_claim=react-query's retry timing
  it("says what's happening before there are results", () => {
    const loading = show({ schedule: undefined });
    expect(loading.field.disabled).toBe(true);
    expect(statusLine()).toBe("Loading the schedule…");
    cleanup();
    const noClock = show({ clock: null });
    expect(noClock.field.disabled).toBe(true);
    expect(statusLine()).toBe("Loading the schedule…");
    cleanup();
    const failed = show({ schedule: undefined, loadFailed: true });
    expect(statusLine()).toBe("Couldn't load the station schedule.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(failed.props.onRetry).toHaveBeenCalledTimes(1);
    cleanup();
    show();
    // An empty field lists what's on now, the broadcast bands first (#109/#110 eng D1, design 2A, 5A, 9A).
    expect(statusLine()).toBe(BROWSE);
    expect(rowNames().map((n) => n!.match(/^[\d,.]+ kHz( USB)?/)![0])).toEqual([
      "9,410 kHz",
      "12,095 kHz",
      "8,957 kHz USB",
    ]);
    expect(screen.getByRole("heading", { name: "Outside the broadcast bands" })).toBeTruthy();
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
    expect(rowNames()).toHaveLength(3);
    expect(statusLine()).toBe(BROWSE);
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
    expect(props.onPickBest).toHaveBeenCalledWith(6195, "am", "search");
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

  // Value: protects=Pick best under a note names and picks for the clicked row's frequency and mode, wherever the dial is now (a refused retune moves it back); fails_when=the button reads the dial, so "doesn't reach 12,095 kHz" is followed by a pick for another frequency; why_new=/ship adversarial review (Codex O1); seam=none; no_claim=the page's dial handling (page test)
  it("picks best for the clicked row, not the dial", () => {
    const { type, props } = show({ freqKhz: 9410, reaches: (khz) => khz < 10_000 });
    type("bbc");
    fireEvent.click(screen.getByRole("button", { name: /^12,095 kHz/ }));
    fireEvent.click(screen.getByRole("button", { name: "Pick best for 12,095 kHz" }));
    expect(props.onPickBest).toHaveBeenCalledWith(12095, "am", "search");
  });

  // Value: protects=the "starts at" note is worded from the clock each minute, and says the broadcast should be on once its start has passed; fails_when=the note keeps the wait from the click ("in 6 h" an hour later) or promises a start that has gone by; why_new=/ship adversarial review (native N2); seam=none; no_claim=none beyond protects
  it("keeps the starts-at note current", () => {
    const { type, rerender } = show();
    type("bbc");
    fireEvent.click(screen.getByRole("button", { name: /^6,195 kHz/ }));
    expect(screen.getByText("BBC · English starts at 18:00 UTC, in 6 h.")).toBeTruthy();
    rerender({ clock: NOW + 5.5 * 3_600_000 });
    expect(screen.getByText("BBC · English starts at 18:00 UTC, in 30 min.")).toBeTruthy();
    rerender({ clock: NOW + 6 * 3_600_000 + 60_000 });
    expect(screen.getByText("BBC · English should be on now.")).toBeTruthy();
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
    expect(announced()).toBe(BROWSE);
    type("b");
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS - 100));
    type("bb");
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS - 100));
    expect(announced()).toBe(BROWSE);
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

  // Value: protects=when filters hide every row the status line names them and what they hid, for a typed name (one station or several) and for the on-now list, and Clear filters (outside the live region) resets area, languages and non-voice; fails_when=the old "isn't scheduled" text shows under filters, or Clear filters leaves one filter set; why_new=#109/#110 eng D6; seam=none; no_claim=screen reader timing (jsdom)
  it("says what the filters hid and clears them", () => {
    const { type } = show();
    type("bbc");
    pickArea("region:af");
    expect(rowNames()).toEqual([]);
    expect(statusLine()).toBe("BBC has 3 broadcasts in the next 24 hours, none to Africa.");
    type("nhk");
    expect(statusLine()).toBe("None of the 2 matching stations are scheduled in the next 24 hours.");
    type("");
    expect(statusLine()).toBe("Nothing to Africa is on now.");
    fireEvent.click(screen.getByLabelText("Include non-voice (time signals, Morse, data)"));
    expect(statusLine()).toBe("Nothing to Africa with non-voice hidden is on now.");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(statusLine()).toBe(BROWSE);
    expect(areaSelect().value).toBe("");
    expect((screen.getByLabelText("Include non-voice (time signals, Morse, data)") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  // Value: protects=filters are saved on change and come back after mount, a corrupt or wrong-shaped value or a storage that throws falls back to no filters without breaking the section, and a saved language the schedule lacks stays picked and is shown marked; fails_when=filters reset every visit, storage is read during render (hydration mismatch), a bad value crashes the section, or a stale pick vanishes (eng D8); why_new=#109/#110 persistence, eng D8, design 4A; seam=none; no_claim=real Safari private-mode quotas
  it("remembers filters", () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ area: "region:eu", languages: ["E", "VN"], nonVoice: false }));
    show();
    expect(areaSelect().value).toBe("region:eu");
    expect(statusLine()).toBe(
      "1 broadcast on now in English or Vietnamese to Europe with non-voice hidden, broadcast bands first. Type a name to find one station.",
    );
    expect(languagesButton().textContent).toBe("English, Vietnamese");
    fireEvent.click(languagesButton());
    expect(screen.getByText("none in this schedule").closest("label")!.textContent).toContain("Vietnamese");
    cleanup();
    pickAreaAfterShow("region:as");
    expect(JSON.parse(localStorage.getItem(FILTERS_KEY)!)).toEqual({
      area: "region:as",
      languages: ["E", "VN"],
      nonVoice: false,
    });
    cleanup();
    // An area this page can't read is Any; the rest is kept.
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ area: "region:mars", languages: ["E"], nonVoice: true }));
    show();
    expect(areaSelect().value).toBe("");
    expect(statusLine()).toMatch(/^3 broadcasts on now in English,/);
    cleanup();
    for (const bad of [
      "{not json",
      JSON.stringify({ area: { region: "eu" }, languages: [], nonVoice: true }),
      JSON.stringify([1]),
      // A value missing the non-voice toggle, or with a language that isn't a code, is also not this page's shape.
      JSON.stringify({ area: "", languages: [] }),
      JSON.stringify({ area: "", languages: [1], nonVoice: true }),
    ]) {
      localStorage.setItem(FILTERS_KEY, bad);
      show();
      expect(statusLine()).toBe(BROWSE);
      cleanup();
    }
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    show();
    expect(statusLine()).toBe(BROWSE);
    pickArea("region:eu");
    expect(statusLine()).toMatch(/^1 broadcast on now to Europe,/);
  });

  // Value: protects=with a placed receiver playing and Area on Any, the held line offers its region and one tap applies it; nothing is applied without the tap, and there's no offer without a position or once an area is set; fails_when=the region applies itself, the offer shows with no receiver, or it pushes the list (the line is always there); why_new=#109 eng D2, design 7A; seam=none; no_claim=the page passing the playing receiver (page test)
  it("offers the receiver's area", () => {
    show({ receiverPlace: { lat: 42.4, lon: -71.1 } });
    expect(areaSelect().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Aimed at North America" }));
    expect(areaSelect().value).toBe("region:na");
    expect(screen.queryByRole("button", { name: /^Aimed at/ })).toBeNull();
    cleanup();
    show();
    expect(screen.queryByRole("button", { name: /^Aimed at/ })).toBeNull();
    expect(document.querySelector(".station-suggest")).toBeTruthy();
  });

  // Value: protects=a filter change starts the list over like a new query: first page, phone overflow closed, note cleared, and the new count read out after the pause; fails_when=a filter change keeps page 3 of the old list or a stale note; why_new=#109/#110 eng Q5; seam=fake timers; no_claim=none beyond protects
  it("starts the list over when a filter changes", () => {
    vi.useFakeTimers();
    const many: SearchSchedule = {
      ...SCHEDULE,
      broadcasts: Array.from({ length: 45 }, (_, i) => b("Many Radio", 5900 + i * 5, 660, 780)),
    };
    const { announced } = show({ schedule: many, freqKhz: 1, idle: true });
    fireEvent.click(screen.getByRole("button", { name: "Show 20 more of 25" }));
    expect(rowNames()).toHaveLength(40);
    fireEvent.click(screen.getByRole("button", { name: /^5,900 kHz/ }));
    expect(screen.getByText("Nothing is playing.")).toBeTruthy();
    pickArea("region:eu");
    expect(rowNames()).toHaveLength(PAGE_ROWS);
    expect(screen.queryByText("Nothing is playing.")).toBeNull();
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS));
    expect(announced()).toMatch(/^45 broadcasts on now to Europe,/);
  });

  // Value: protects=Pick best under a note about a row from the on-now list reports source "browse", and one from a typed name "search", so #61 can tell browsing from searching; fails_when=browse picks are recorded as "search"; why_new=#109/#110 eng D9 (owner raised it); seam=none; no_claim=the page passing it to Pick best (page test)
  it("labels a pick from the on-now list browse", () => {
    const { props, type } = show({ idle: true });
    fireEvent.click(screen.getByRole("button", { name: /^9,410 kHz/ }));
    fireEvent.click(screen.getByRole("button", { name: "Pick best for 9,410 kHz" }));
    expect(props.onPickBest).toHaveBeenLastCalledWith(9410, "am", "browse");
    type("bbc");
    fireEvent.click(screen.getByRole("button", { name: /^9,410 kHz/ }));
    fireEvent.click(screen.getByRole("button", { name: "Pick best for 9,410 kHz" }));
    expect(props.onPickBest).toHaveBeenLastCalledWith(9410, "am", "search");
  });

  // Value: protects=the Languages control: the button names the picks ("Any language", then names, "+N" past two), opens a panel whose filter field takes focus, filters by name, says when nothing matches, ticks a language into the filter, keeps picks first on the next opening, and Escape closes it with focus back on the button; fails_when=focus is lost on close, picks hide behind "+N" with no way to find them, or a tick doesn't filter; why_new=#110 design 3A, 4A; seam=none; no_claim=the floating/in-place layout (CSS, no media queries in jsdom)
  it("picks languages from a filterable panel", () => {
    const many: SearchSchedule = {
      ...SCHEDULE,
      broadcasts: [
        ...SCHEDULE.broadcasts,
        b("Radio Paris", 9800, 660, 780, { lang: "F" }),
        b("Radio Ankara", 9900, 660, 780, { lang: "TU" }),
        b("RAI", 9950, 660, 780, { lang: "I" }),
      ],
    };
    show({ schedule: many });
    expect(languagesButton().textContent).toBe("Any language");
    fireEvent.click(languagesButton());
    const filter = screen.getByLabelText("Filter languages");
    expect(document.activeElement).toBe(filter);
    expect(panelOptions()).toEqual(["English", "French", "Italian", "Turkish"]);
    fireEvent.change(filter, { target: { value: "zz" } });
    expect(screen.getByText("No language matches “zz”.")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "tur" } });
    fireEvent.click(screen.getByLabelText("Turkish"));
    expect(statusLine()).toMatch(/^1 broadcast on now in Turkish,/);
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(screen.queryByLabelText("Filter languages")).toBeNull();
    expect(document.activeElement).toBe(languagesButton());
    fireEvent.click(languagesButton());
    fireEvent.click(screen.getByLabelText("French"));
    fireEvent.click(screen.getByLabelText("Italian"));
    expect(languagesButton().textContent).toBe("French, Italian +1");
    // The status line names all three, where the button stops at two.
    expect(statusLine()).toMatch(/^3 broadcasts on now in French, Italian or Turkish,/);
    fireEvent.keyDown(screen.getByLabelText("Filter languages"), { key: "Escape" });
    fireEvent.click(languagesButton());
    expect(panelOptions()).toEqual(["French", "Italian", "Turkish", "English"]);
  });

  // Value: protects=saved filters are read out once they apply, even when the schedule was already held at mount (announced unfiltered first); fails_when=a screen-reader user hears the unfiltered count and never the filtered one; why_new=build review (bugs reviewer, item 3); seam=fake timers; no_claim=real screen reader behaviour
  it("reads the filtered count out after saved filters load", () => {
    vi.useFakeTimers();
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ area: "region:eu", languages: [], nonVoice: true }));
    const { announced } = show();
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS));
    expect(announced()).toMatch(/^1 broadcast on now to Europe,/);
  });

  // Value: protects=the Languages panel closes when focus leaves it (Tab past the last row), not only on Escape or a click outside, and a stale pick unticked while open stays listed until it closes (design 4A: rows don't move while open); fails_when=a keyboard user leaves the panel floating over the list, or the stale row vanishes under the pointer; why_new=build review (bugs reviewer, items 1-2); seam=none; no_claim=real browser focus order
  it("closes the Languages panel when focus leaves and keeps a stale row while open", () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ area: "", languages: ["VN"], nonVoice: true }));
    show();
    fireEvent.click(languagesButton());
    fireEvent.click(screen.getByLabelText(/Vietnamese/));
    expect(panelOptions()).toContain("Vietnamesenone in this schedule");
    expect((screen.getByLabelText(/Vietnamese/) as HTMLInputElement).checked).toBe(false);
    fireEvent.blur(screen.getByLabelText("Filter languages"), { relatedTarget: areaSelect() });
    expect(screen.queryByLabelText("Filter languages")).toBeNull();
    fireEvent.click(languagesButton());
    expect(panelOptions()).not.toContain("Vietnamesenone in this schedule");
  });

  // Value: protects=a specific area code from the select narrows the list, is named in the status line from the target names and saved as "code:...", and a saved code the schedule no longer uses comes back selected with its own "(none in this schedule)" option, worded in the status (several matching stations too) and cleared by Clear filters, which puts focus back in the name field; fails_when=areaOf/areaValue mangle a code, the stale code has no option (the select would show Any while the filter still hides every row), the status drops the area's name, or Clear filters leaves focus on a button that just vanished; why_new=component tests only pick broad regions, and areaCodes' stale entry is checked only in its lib test, not that the select offers it; seam=none; no_claim=the region table
  it("filters by one area code and keeps a stale saved one clearable", () => {
    show();
    pickArea("code:SAs");
    expect(areaSelect().value).toBe("code:SAs");
    expect(rowNames().map((n) => n!.match(/^[\d,.]+ kHz/)![0])).toEqual(["12,095 kHz"]);
    expect(statusLine()).toBe("1 broadcast on now to South Asia, broadcast bands first. Type a name to find one station.");
    expect(JSON.parse(localStorage.getItem(FILTERS_KEY)!)).toMatchObject({ area: "code:SAs" });
    cleanup();
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ area: "code:XYZ", languages: [], nonVoice: true }));
    const { field, type } = show();
    expect(areaSelect().value).toBe("code:XYZ");
    expect(screen.getByRole("option", { name: "XYZ (none in this schedule)" })).toBeTruthy();
    expect(statusLine()).toBe("Nothing to XYZ is on now.");
    type("o");
    expect(statusLine()).toBe("The 3 matching stations have 1 broadcast in the next 24 hours, none to XYZ.");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(areaSelect().value).toBe("");
    expect(document.activeElement).toBe(field);
  });

  // Value: protects=the Languages panel closes on a press anywhere outside it and stays open for a press inside it (a checkbox), and the button closes it again; fails_when=the outside-press listener is dropped (the panel floats over the list until Escape) or its contains check flips (ticking a language shuts the panel); why_new=Escape and focus-out are tested, the outside press is not; seam=none; no_claim=real pointer/touch event order in browsers
  it("closes the Languages panel on a press outside it, not inside", () => {
    show();
    fireEvent.click(languagesButton());
    fireEvent.pointerDown(screen.getByLabelText("English"));
    expect(screen.getByLabelText("Filter languages")).toBeTruthy();
    fireEvent.pointerDown(areaSelect());
    expect(screen.queryByLabelText("Filter languages")).toBeNull();
    fireEvent.click(languagesButton());
    expect(screen.getByLabelText("Filter languages")).toBeTruthy();
    fireEvent.click(languagesButton());
    expect(screen.queryByLabelText("Filter languages")).toBeNull();
  });
});
