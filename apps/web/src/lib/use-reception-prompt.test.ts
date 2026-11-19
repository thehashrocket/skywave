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
  SAME_CHANNEL_SLACK_MS,
  THANKS_MS,
  useReceptionPrompt,
} from "./use-reception-prompt";
import { LISTING_GRACE_MS, SAME_CHANNEL_MS, STREAM_LATENCY_MS, type BeaconPick } from "./reception";
import { noteResponse, resetServerClock, serverNow } from "./server-clock";

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
type Props = {
  status: RadioStatus;
  heard: boolean;
  schedule: readonly Broadcast[] | undefined;
  onList?: boolean;
  beacon?: BeaconPick | null;
};

function setup(initial: Partial<Props> = {}) {
  const initialProps: Props = { status: listening(), heard: true, schedule, ...initial };
  return renderHook(
    (p: Props) => useReceptionPrompt(p.status, p.heard, p.schedule, p.onList ?? true, p.beacon ?? null),
    { initialProps },
  );
}

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("useReceptionPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 18, 12) });
    sessionStorage.clear();
    resetServerClock();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetServerClock();
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

  // Value: protects=on a broadcast (not a beacon) a server-clock offset becoming known or replaced doesn't start the minute over, as the hook's doc says (broadcasts run on this browser's clock); fails_when=the plan restarts on every clock epoch, not only on a beacon frequency, so a broadcast question slips a minute; why_new=the clock-epoch test covers a beacon pick only; seam=fake timers, the real server clock fed responses; no_claim=how a browser's monotonic clock behaves in sleep
  it("doesn't start a broadcast's minute over when the server clock changes", () => {
    const hook = setup();
    wait(DWELL_MS - 20_000);
    // The first offset arrives mid-minute, then a sleep the monotonic clock lagged through replaces it.
    act(() => noteResponse(new Headers({ date: new Date(Date.now()).toUTCString() }), Date.now(), Date.now()));
    wait(5_000);
    vi.setSystemTime(Date.now() + 60_000);
    act(() => noteResponse(new Headers({ date: new Date(Date.now()).toUTCString() }), Date.now() - 100, Date.now()));
    wait(15_000 - 1);
    expect(hook.result.current.prompt).toBeNull();
    wait(1);
    expect(hook.result.current.prompt?.tx.name).toBe("KBS World Radio");
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

  // Value: protects=the question gap runs on the server's clock, so setting the computer's clock back an hour mid-visit neither holds the next question back an hour nor brings it forward; fails_when=lastShownMs or the gap's wait is read off Date.now(); why_new=P4 TODO (owner: gap timers on server time); seam=fake timers (setSystemTime moves only Date), the real server clock fed a response, a fetch that never answers; no_claim=sessionStorage values saved by an older page (Date-based)
  it("keeps the question gap when the computer's clock is set back", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    noteResponse(new Headers({ "x-server-ms": String(Date.now()) }), Date.now(), Date.now());
    const hook = setup();
    wait(DWELL_MS);
    act(() => hook.result.current.answered());
    vi.setSystemTime(Date.now() - 3_600_000);
    hook.rerender({ status: listening(6_070), heard: true, schedule });
    wait(PROMPT_GAP_MS - 1);
    expect(hook.result.current.prompt).toBeNull();
    wait(1);
    expect(hook.result.current.prompt?.tx.name).toBe("CFRX");
    vi.unstubAllGlobals();
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

  describe("on a beacon frequency", () => {
    // The clock starts at 12:00:00 UTC, the top of a cycle: 4U1UN on 14.100 until 12:00:10.
    const beaconStatus = (freqKhz = 14_100): RadioStatus => ({ ...listening(freqKhz), mode: "cw" });
    const pick: BeaconPick = { call: "4U1UN", bandIndex: 0 };

    // Value: protects=on one receiver and band, each beacon is its own question (4U1UN, then YV5B, both asked, after the 10-minute gap), and a beacon this tab already answered about there isn't asked again until the server would take the answer (30 min + slack), so the page never thanks for an answer the server drops; EiBi's one-per-channel stays as it was (other tests); fails_when=the one-per-channel key ignores the callsign, or the sent-answer record is missing, lost, or too short; why_new=owner: beacon answers dropped after thanks (option 3 + per-callsign key); seam=fake timers + jsdom sessionStorage; no_claim=the server's own limit (reports tests)
    it("asks about each beacon once per receiver and band, and not again before the server would take it", () => {
      const hook = setup({ status: beaconStatus(), beacon: pick });
      wait(10_000 + STREAM_LATENCY_MS);
      expect(hook.result.current.prompt?.tx.name).toBe("4U1UN");
      // Answered at 12:00:11.5.
      act(() => hook.result.current.answered());

      // YV5B picked on the same receiver and band: a new question, at its first turn after
      // the 10-minute gap (12:10:11.5). YV5B has 14.100 at :50 past each cycle: 12:11:50,
      // asked 12:12:01.5.
      hook.rerender({ status: beaconStatus(), heard: true, schedule, beacon: { call: "YV5B", bandIndex: 0 } });
      wait(PROMPT_GAP_MS + 110_000 - 1);
      expect(hook.result.current.prompt).toBeNull();
      wait(1);
      expect(hook.result.current.prompt?.tx.name).toBe("YV5B");
      act(() => hook.result.current.answered());

      // 4U1UN again, here, at 12:12:01.5: not before 12:31:11.5 (its answer + 30 min + slack),
      // so not its 12:30:00 turn (asked 12:30:11.5) but 12:33:00 (asked 12:33:11.5).
      expect(SAME_CHANNEL_MS + SAME_CHANNEL_SLACK_MS).toBe(31 * 60_000);
      hook.rerender({ status: beaconStatus(), heard: true, schedule, beacon: pick });
      wait(21 * 60_000 + 10_000 - 1);
      expect(hook.result.current.prompt).toBeNull();
      wait(1);
      expect(hook.result.current.prompt?.tx.name).toBe("4U1UN");
    });

    // Value: protects=a beacon question whose timer outlived a sleep isn't asked about the long-gone turn (its answer could reach the server after it stops taking that slot), and the switch to the computer's clock re-plans for a turn on the corrected clock; fails_when=the timer asks whatever its slot's age, or the switch doesn't re-plan; why_new=clock-edges TODO (Codex adversarial: stale question after sleep, owner: core set); seam=fake timers (setSystemTime moves only Date while performance.now and the timer paused), the real server clock fed a response; no_claim=how a browser runs timers across a real sleep
    it("skips a question a sleep made too old, and asks a later turn", async () => {
      noteResponse(new Headers({ date: new Date(Date.now()).toUTCString() }), Date.now(), Date.now());
      const hook = setup({ status: beaconStatus(), beacon: pick });
      // Planned: 4U1UN's 12:00:00 turn, asked at 12:00:11.5.
      expect(hook.result.current.beaconAskSlotMs).toBe(Date.UTC(2026, 10, 18, 12));
      wait(5_000);
      // Ten minutes asleep: the computer's clock and the server moved on; performance.now() and the timer didn't.
      vi.setSystemTime(Date.now() + 600_000);
      await act(async () => {
        vi.advanceTimersByTime(6_500);
      });
      expect(hook.result.current.prompt).toBeNull();
      // Re-planned from 12:10:11.5 on the corrected clock: 4U1UN's next turn on that band is 12:12:00.
      expect(hook.result.current.beaconAskSlotMs).toBe(Date.UTC(2026, 10, 18, 12, 12));
      wait(Date.UTC(2026, 10, 18, 12, 12) + 10_000 + STREAM_LATENCY_MS - serverNow());
      expect(hook.result.current.prompt?.tx).toMatchObject({ name: "4U1UN", slotStartMs: Date.UTC(2026, 10, 18, 12, 12) });
    });

    // Value: protects=a beacon prompt left on screen through a sleep (its timer paused) closes when the clock moves past the server's window for its turn, so no thanks shows for an answer the server would refuse, while a fresh prompt survives a clock move; fails_when=the prompt only closes on its own timer; why_new=P4 TODO (owner: expire stale prompts on wake); seam=fake timers (setSystemTime models the wall clock moving on while performance.now paused), the real server clock fed a response, a fetch that never answers; no_claim=how a real browser runs timers across a sleep
    it("closes a beacon prompt a sleep left too old, and keeps a fresh one", async () => {
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
      noteResponse(new Headers({ "x-server-ms": String(Date.now()) }), Date.now(), Date.now());
      const hook = setup({ status: beaconStatus(), beacon: pick });
      wait(10_000 + STREAM_LATENCY_MS);
      expect(hook.result.current.prompt?.tx.name).toBe("4U1UN");
      // A small jump: the prompt's turn is still well inside the server's window.
      vi.setSystemTime(Date.now() + 2_500);
      await act(async () => void serverNow());
      expect(hook.result.current.prompt?.tx.name).toBe("4U1UN");
      // Ten minutes asleep: the server would no longer take an answer about that turn.
      vi.setSystemTime(Date.now() + 600_000);
      await act(async () => void serverNow());
      expect(hook.result.current.prompt).toBeNull();
      vi.unstubAllGlobals();
    });

    // Value: protects=when the server-clock offset is replaced (a sleep the monotonic clock lagged through), the beacon question drops its old plan and starts over on the new clock: audio counted from then, the turn asked about and the band strip's inputs all on one clock, never asked at the old plan's time; fails_when=the plan ignores offset changes, so it fires on the old clock while the strip moved (PR #74 red team); why_new=clock TODO (owner: monotonic clock + re-plan); seam=fake timers, the real server clock fed a response; no_claim=how a browser's monotonic clock behaves in sleep
    it("starts its plan over on a new clock when the offset is replaced", () => {
      noteResponse(new Headers({ date: new Date(Date.now()).toUTCString() }), Date.now(), Date.now());
      const hook = setup({ status: beaconStatus(), beacon: pick });
      // Planned: 4U1UN's 12:00:00 turn, asked at 12:00:11.5.
      expect(hook.result.current.beaconAskSlotMs).toBe(Date.UTC(2026, 10, 18, 12));
      wait(5_000);
      // A minute asleep: the computer's clock and the server moved on, performance.now() didn't.
      vi.setSystemTime(Date.now() + 60_000);
      act(() => noteResponse(new Headers({ date: new Date(Date.now()).toUTCString() }), Date.now() - 100, Date.now()));
      const restarted = hook.result.current.beaconAudioStartMs!;
      expect(Math.abs(restarted - serverNow())).toBeLessThan(10);
      // Not at the old plan's time, but at 4U1UN's next turn on the new clock: 12:03:00, asked 12:03:11.5.
      expect(hook.result.current.beaconAskSlotMs).toBe(Date.UTC(2026, 10, 18, 12, 3));
      wait(6_500);
      expect(hook.result.current.prompt).toBeNull();
      wait(Date.UTC(2026, 10, 18, 12, 3) + 10_000 + STREAM_LATENCY_MS - serverNow() - 1);
      expect(hook.result.current.prompt).toBeNull();
      wait(1);
      expect(hook.result.current.prompt?.tx).toMatchObject({ name: "4U1UN", slotStartMs: Date.UTC(2026, 10, 18, 12, 3) });
    });

    // Value: protects=the sent-answer record survives a reload in the tab (sessionStorage), like the gap; fails_when=it lives in memory only, so a reload asks again and the server drops the answer; why_new=owner: beacon answers dropped after thanks; seam=jsdom sessionStorage; no_claim=none
    it("remembers a beacon answer across a reload in the tab", () => {
      const first = setup({ status: beaconStatus(), beacon: pick });
      wait(10_000 + STREAM_LATENCY_MS);
      act(() => first.result.current.answered());
      first.unmount();
      // A reload 15 minutes later: the gap has passed, but not 30 minutes since the answer.
      wait(15 * 60_000);
      const again = setup({ status: beaconStatus(), beacon: pick });
      wait(10 * 60_000);
      expect(again.result.current.prompt).toBeNull();
      wait(10 * 60_000);
      expect(again.result.current.prompt?.tx.name).toBe("4U1UN");
    });

    // Value: protects=the beacon picked with Listen is asked about once its slot's end reaches the listener, by callsign; fails_when=the beacon path uses the one-minute dwell or names another beacon; why_new=beacon prompt (owner rule); seam=fake timers; no_claim=the rule's arithmetic (reception.test)
    it("asks about the picked beacon after its slot", () => {
      const hook = setup({ status: beaconStatus(), beacon: pick });
      wait(10_000 + STREAM_LATENCY_MS - 1);
      expect(hook.result.current.prompt).toBeNull();
      wait(1);
      expect(hook.result.current.prompt).toEqual({
        host: "a.example",
        port: 8073,
        freqKhz: 14_100,
        mode: "cw",
        // The slot asked about: 12:00:00, the one just heard.
        tx: { kind: "beacon", name: "4U1UN", detail: "14100", label: "4U1UN", slotStartMs: Date.UTC(2026, 10, 18, 12) },
      });
    });

    // Value: protects=too little of the slot heard waits for the beacon's next turn on the band (3 minutes); fails_when=a short slot is asked about; why_new=beacon prompt (owner rule); seam=fake timers; no_claim=none
    it("waits for the next turn when audio started too late in the slot", () => {
      wait(4_000);
      const hook = setup({ status: beaconStatus(), beacon: pick });
      wait(60_000);
      expect(hook.result.current.prompt).toBeNull();
      wait(180_000 - 4_000 - 60_000 + 10_000 + STREAM_LATENCY_MS);
      expect(hook.result.current.prompt?.tx.name).toBe("4U1UN");
    });

    // Value: protects=no prompt for a beacon frequency tuned by hand, nor for a pick made on another band, nor an EiBi question there; fails_when=a dwell on 14.100 asks about some beacon or station; why_new=beacon prompt (owner rule: no prompt for manual tuning); seam=fake timers; no_claim=none
    it("asks nothing without a Listen pick on this band", () => {
      const onBeacon = [...schedule, allDay(14_100, "Some Station")].sort((a, b) => a.khz - b.khz);
      const hook = setup({ status: beaconStatus(), schedule: onBeacon });
      wait(PROMPT_GAP_MS);
      expect(hook.result.current.prompt).toBeNull();
      hook.rerender({
        status: beaconStatus(),
        heard: true,
        schedule: onBeacon,
        beacon: { call: "4U1UN", bandIndex: 3 },
      });
      wait(PROMPT_GAP_MS);
      expect(hook.result.current.prompt).toBeNull();
    });
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
