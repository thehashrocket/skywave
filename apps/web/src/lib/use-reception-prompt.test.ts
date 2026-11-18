// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Broadcast } from "./eibi";
import type { RadioStatus } from "./use-radio";
import {
  DWELL_MS,
  MAX_DISMISSALS,
  PROMPT_GAP_MS,
  PROMPT_TTL_MS,
  THANKS_MS,
  useReceptionPrompt,
} from "./use-reception-prompt";
import { LISTING_GRACE_MS } from "./reception";

const allDay = (khz: number, station: string, lang = "E", target = "Eu"): Broadcast => ({
  khz,
  start: 0,
  end: 1440,
  days: "",
  station,
  lang,
  target,
});

// Sorted by frequency, as the server sends it. 5,000 kHz has nothing scheduled.
const schedule: Broadcast[] = [
  allDay(6_070, "CFRX"),
  allDay(9_580, "KBS World Radio", "E", "NAm"),
  allDay(9_580, "KBS World Radio", "K", "NAm"),
  allDay(11_700, "Radio A"),
  allDay(11_700, "Radio B"),
];

const listening = (freqKhz = 9_580, host = "a.example"): RadioStatus => ({
  state: "listening",
  host,
  port: 8073,
  freqKhz,
  mode: "am",
});

/** `onList` left out means the receiver is on the public list. */
type Props = { status: RadioStatus; heard: boolean; schedule: readonly Broadcast[] | undefined; onList?: boolean };

function setup(initial: Partial<Props> = {}) {
  const initialProps: Props = { status: listening(), heard: true, schedule, ...initial };
  return renderHook((p: Props) => useReceptionPrompt(p.status, p.heard, p.schedule, p.onList ?? true), {
    initialProps,
  });
}

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("useReceptionPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 18, 12) });
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Value: protects=the prompt asks only after a full minute of audio actually heard on a scheduled station, naming the receiver and tuning it was heard on; fails_when=the timer starts on connect rather than first audio, or fires early; why_new=reception prompt; seam=fake timers; no_claim=the page's choice of status/heardAudio
  it("asks after a minute of heard audio on a scheduled station, not before", () => {
    const hook = setup({ heard: false });
    wait(DWELL_MS * 2);
    expect(hook.result.current.prompt).toBeNull();
    hook.rerender({ status: listening(), heard: true, schedule });
    wait(DWELL_MS - 1);
    expect(hook.result.current.prompt).toBeNull();
    wait(1);
    expect(hook.result.current.prompt).toEqual({
      host: "a.example",
      port: 8073,
      freqKhz: 9_580,
      mode: "am",
      tx: { kind: "eibi", name: "KBS World Radio", detail: "E/NAm", label: "KBS World Radio" },
    });
  });

  it("asks nothing where nothing is scheduled, or before the schedule loads", () => {
    const hook = setup({ status: listening(5_000) });
    wait(DWELL_MS * 2);
    expect(hook.result.current.prompt).toBeNull();
    hook.rerender({ status: listening(), heard: true, schedule: undefined });
    wait(DWELL_MS * 2);
    expect(hook.result.current.prompt).toBeNull();
    // The schedule arriving starts the wait.
    hook.rerender({ status: listening(), heard: true, schedule });
    wait(DWELL_MS);
    expect(hook.result.current.prompt?.tx.name).toBe("KBS World Radio");
  });

  it("asks about two or three stations sharing a frequency together", () => {
    const hook = setup({ status: listening(11_700) });
    wait(DWELL_MS);
    expect(hook.result.current.prompt?.tx).toEqual({
      kind: "eibi",
      name: "Radio A / Radio B",
      label: "anything from Radio A or Radio B",
    });
  });

  // Value: protects=the minute is a minute unchanged: a retune, mode change, receiver change, Stop, error or audio dropping starts it over; fails_when=any of these doesn't reset the timer; why_new=reception prompt; seam=fake timers; no_claim=none beyond protects
  it.each<[string, Props]>([
    ["a retune", { status: listening(6_070), heard: true, schedule }],
    ["a mode change", { status: { ...listening(), mode: "usb" }, heard: true, schedule }],
    ["another receiver", { status: listening(9_580, "b.example"), heard: true, schedule }],
    ["Stop", { status: { state: "stopped" }, heard: false, schedule }],
    ["an error", { status: { state: "error", code: "closed" }, heard: false, schedule }],
    ["a new connection with no audio yet", { status: { state: "connecting" }, heard: false, schedule }],
  ])("starts the minute over on %s", (_, change) => {
    const hook = setup();
    wait(DWELL_MS - 1_000);
    hook.rerender(change);
    hook.rerender({ status: listening(), heard: true, schedule });
    wait(DWELL_MS - 1);
    expect(hook.result.current.prompt).toBeNull();
    wait(1);
    expect(hook.result.current.prompt).not.toBeNull();
  });

  it("hides a showing prompt on a retune, but keeps it after Stop", () => {
    const hook = setup();
    wait(DWELL_MS);
    hook.rerender({ status: { state: "stopped" }, heard: false, schedule });
    expect(hook.result.current.prompt?.freqKhz).toBe(9_580);
    hook.rerender({ status: listening(6_070), heard: true, schedule });
    expect(hook.result.current.prompt).toBeNull();
  });

  // Value: protects=at most one prompt per 10 minutes in a tab: another station after an answer waits out the gap, then is asked; the same channel isn't asked twice; fails_when=the gap isn't enforced, is measured from the wrong moment, or blocks forever; why_new=reception prompt; seam=fake timers + jsdom sessionStorage; no_claim=none beyond protects
  it("doesn't ask twice on one channel, however long it plays", () => {
    const hook = setup();
    wait(DWELL_MS);
    act(() => hook.result.current.answered());
    wait(PROMPT_GAP_MS * 3);
    expect(hook.result.current.prompt).toBeNull();
    // Even when its listing drops out and a new one starts while it plays.
    hook.rerender({ status: listening(), heard: true, schedule: [] });
    hook.rerender({ status: listening(), heard: true, schedule });
    wait(PROMPT_GAP_MS * 3);
    expect(hook.result.current.prompt).toBeNull();
  });

  it("keeps the gap across a reload in the same tab", () => {
    sessionStorage.setItem(
      "skywave.receptionPrompt",
      JSON.stringify({ lastShownMs: Date.now() - DWELL_MS, dismissals: 0 }),
    );
    const hook = setup();
    wait(DWELL_MS);
    expect(hook.result.current.prompt).toBeNull();
    wait(PROMPT_GAP_MS - 2 * DWELL_MS);
    expect(hook.result.current.prompt).not.toBeNull();
  });

  it("asks at most once per 10 minutes, waiting out the gap for the next station", () => {
    const hook = setup();
    wait(DWELL_MS);
    act(() => hook.result.current.answered());
    // Retuned the moment it was answered, a gap after the last prompt showed.
    hook.rerender({ status: listening(6_070), heard: true, schedule });
    wait(DWELL_MS);
    expect(hook.result.current.prompt).toBeNull();
    wait(PROMPT_GAP_MS - DWELL_MS - 1);
    expect(hook.result.current.prompt).toBeNull();
    wait(1);
    expect(hook.result.current.prompt?.tx.name).toBe("CFRX");
  });

  // Value: protects=closing the prompt twice stops it for the rest of the tab's session, while answering never counts as a close; fails_when=dismissals aren't counted, answers count as dismissals, or the stop doesn't hold after the gap; why_new=reception prompt; seam=fake timers + jsdom sessionStorage; no_claim=none beyond protects
  it(`stops asking after ${MAX_DISMISSALS} closes, and answers don't count`, () => {
    const hook = setup();
    const askOn = (khz: number) => {
      hook.rerender({ status: listening(khz), heard: true, schedule });
      wait(PROMPT_GAP_MS);
      expect(hook.result.current.prompt?.freqKhz).toBe(khz);
    };
    wait(DWELL_MS);
    act(() => hook.result.current.answered());
    askOn(6_070);
    act(() => hook.result.current.dismiss());
    askOn(9_580);
    act(() => hook.result.current.dismiss());
    hook.rerender({ status: listening(11_700), heard: true, schedule });
    wait(PROMPT_GAP_MS * 3);
    expect(hook.result.current.prompt).toBeNull();
  });

  it("keeps working when sessionStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const hook = setup();
    wait(DWELL_MS);
    expect(hook.result.current.prompt).not.toBeNull();
    act(() => hook.result.current.dismiss());
    // Counts still held in memory: the gap applies.
    hook.rerender({ status: listening(6_070), heard: true, schedule });
    wait(DWELL_MS);
    expect(hook.result.current.prompt).toBeNull();
  });

  // Value: protects=a receiver the listener typed in (not on the public list) is never asked about, since the server drops every report about it, and the list arriving mid-listen starts the wait; fails_when=onList is ignored, or a late list never starts the timer; why_new=PR #63 review: answers the server can't keep; seam=fake timers; no_claim=the page's choice of onList (page tests)
  it("asks nothing about a receiver that isn't on the public list", () => {
    const hook = setup({ onList: false });
    wait(DWELL_MS * 3);
    expect(hook.result.current.prompt).toBeNull();
    hook.rerender({ status: listening(), heard: true, schedule, onList: true });
    wait(DWELL_MS);
    expect(hook.result.current.prompt).not.toBeNull();
  });

  // Value: protects=an unanswered prompt goes away before the server's 5-minute grace runs out (after Stop too), so no one answers a question whose answer is dropped, and timing out doesn't count as a close; fails_when=the prompt stays past the grace, the timeout is at or over the grace, or it counts toward MAX_DISMISSALS; why_new=PR #63 review; seam=fake timers; no_claim=client and server clocks agreeing beyond the one-minute margin
  it("closes an unanswered prompt before the server would stop taking the answer", () => {
    expect(PROMPT_TTL_MS).toBeLessThan(LISTING_GRACE_MS);
    const hook = setup();
    wait(DWELL_MS);
    hook.rerender({ status: { state: "stopped" }, heard: false, schedule });
    wait(PROMPT_TTL_MS - 1);
    expect(hook.result.current.prompt).not.toBeNull();
    wait(1);
    expect(hook.result.current.prompt).toBeNull();
    // Not a close: two timeouts later it still asks.
    for (const khz of [6_070, 11_700, 9_580]) {
      hook.rerender({ status: listening(khz), heard: true, schedule });
      wait(PROMPT_GAP_MS);
      expect(hook.result.current.prompt?.freqKhz).toBe(khz);
      wait(PROMPT_TTL_MS);
    }
  });

  it("says thanks after an answer, briefly", () => {
    const hook = setup();
    wait(DWELL_MS);
    act(() => hook.result.current.answered());
    expect(hook.result.current).toMatchObject({ prompt: null, thanked: true });
    wait(THANKS_MS);
    expect(hook.result.current.thanked).toBe(false);
  });
});
