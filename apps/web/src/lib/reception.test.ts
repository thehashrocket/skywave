import { describe, expect, it } from "vitest";
import type { Broadcast } from "./eibi";
import {
  BEACON_MIN_HEARD_MS,
  beaconPromptAt,
  beaconTransmitter,
  beaconWatch,
  eibiTransmitter,
  formatCountdown,
  noQuestionReason,
  STREAM_LATENCY_MS,
} from "./reception";

const b = (station: string, lang = "E", target = "Eu", khz = 9_580): Broadcast => ({
  khz,
  start: 0,
  end: 1440,
  days: "",
  station,
  lang,
  target,
});

describe("eibiTransmitter", () => {
  it("is null with nothing scheduled", () => {
    expect(eibiTransmitter([])).toBeNull();
  });

  it("names one station, with its first listing's language and target", () => {
    expect(eibiTransmitter([b("KBS World Radio", "E", "NAm"), b("KBS World Radio", "K", "NAm")])).toEqual({
      kind: "eibi",
      name: "KBS World Radio",
      detail: "E/NAm",
      label: "KBS World Radio",
    });
  });

  it.each([
    [["A", "B"], "anything from A or B", "A / B"],
    [["A", "B", "C"], "anything from A, B or C", "A / B / C"],
  ])("asks about %j together", (stations, label, name) => {
    expect(eibiTransmitter(stations.map((s) => b(s)))).toEqual({ kind: "eibi", name, label });
  });

  it("names only the nearest listing when more than three share it", () => {
    const tx = eibiTransmitter(["Near", "B", "C", "D"].map((s) => b(s)));
    expect(tx).toMatchObject({ name: "Near", label: "Near" });
  });
});

describe("beaconPromptAt", () => {
  // 00:00:00 UTC opens a cycle: 4U1UN on 14.100 (band 0) until 00:00:10.
  const t = (s: number) => Date.UTC(2026, 10, 18, 0, 0, 0) + s * 1000;
  const pick = { call: "4U1UN", bandIndex: 0 };

  // Value: protects=the owner's rule: a slot counts once at least 7 s of it played after first audio plus 1.5 s latency, asked when its end reaches the listener; fails_when=latency isn't added, the threshold is off by any amount, or the prompt comes before the slot's end is heard; why_new=beacon prompt (owner rule); seam=none; no_claim=actual stream latency
  it("asks after the picked beacon's slot when at least 7 s of it played", () => {
    expect(BEACON_MIN_HEARD_MS).toBe(7_000);
    expect(STREAM_LATENCY_MS).toBe(1_500);
    // Audio at 1 s, heard from 2.5 s: 7.5 s of the slot.
    expect(beaconPromptAt(pick, t(1), 0)?.askAtMs).toBe(t(10) + STREAM_LATENCY_MS);
    // Audio at 1.5 s, heard from 3 s: exactly 7 s counts.
    expect(beaconPromptAt(pick, t(1.5), 0)?.askAtMs).toBe(t(10) + STREAM_LATENCY_MS);
    // Audio before the slot: all of it.
    expect(beaconPromptAt(pick, t(-30), 0)?.askAtMs).toBe(t(10) + STREAM_LATENCY_MS);
  });

  // Value: protects=too little of the slot left means no question this time, but the same pick qualifies on its next turn on the band 3 minutes later; fails_when=a short slot is asked about, or the next turn is computed wrong; why_new=beacon prompt (owner rule); seam=none; no_claim=none
  it("skips a slot with less than 7 s heard and waits for the beacon's next turn", () => {
    // Audio at 1.6 s, heard from 3.1 s: 6.9 s.
    expect(beaconPromptAt(pick, t(1.6), 0)?.askAtMs).toBe(t(180 + 10) + STREAM_LATENCY_MS);
    // Audio after the slot ended entirely.
    expect(beaconPromptAt(pick, t(20), 0)?.askAtMs).toBe(t(180 + 10) + STREAM_LATENCY_MS);
  });

  // Value: protects=the slot is the picked beacon's on the picked band (it reaches band b at its own slot plus b), and the prompt gap pushes it to a later turn; fails_when=the band offset is applied the wrong way, or the gap is ignored; why_new=beacon prompt; seam=none; no_claim=none
  it("finds the beacon's turn on its band, and waits out the prompt gap", () => {
    // 4U1UN reaches 21.150 (band 2) at 00:00:20.
    expect(beaconPromptAt({ call: "4U1UN", bandIndex: 2 }, t(0), 0)?.askAtMs).toBe(t(30) + STREAM_LATENCY_MS);
    // YV5B, last in the list, is on 18.110 (band 1) in the first slot.
    expect(beaconPromptAt({ call: "YV5B", bandIndex: 1 }, t(0), 0)?.askAtMs).toBe(t(10) + STREAM_LATENCY_MS);
    expect(beaconPromptAt(pick, t(1), t(200))?.askAtMs).toBe(t(360 + 10) + STREAM_LATENCY_MS);
    expect(beaconPromptAt({ call: "NOPE", bandIndex: 0 }, t(0), 0)).toBeNull();
  });

  // Value: protects=the slot the report carries is the one asked about (the server checks it against the schedule), on the 10 s grid; fails_when=it's the ask time, or a skipped slot's start; why_new=tightened beacon server check; seam=none; no_claim=none
  it("names the slot it asks about", () => {
    expect(beaconPromptAt(pick, t(1), 0)?.slotStartMs).toBe(t(0));
    expect(beaconPromptAt(pick, t(1.6), 0)?.slotStartMs).toBe(t(180));
    expect(beaconPromptAt({ call: "4U1UN", bandIndex: 2 }, t(0), 0)?.slotStartMs).toBe(t(20));
  });

  // Value: protects=the stored report names the beacon by callsign, its band as the detail (schema.prisma's txDetail) and the slot asked about; fails_when=the shape drifts from what the server checks; why_new=beacon prompt; seam=none; no_claim=none
  it("names the beacon, its band and its slot", () => {
    expect(beaconTransmitter({ call: "4X6TU", bandIndex: 4 }, t(40))).toEqual({
      kind: "beacon",
      name: "4X6TU",
      detail: "28200",
      label: "4X6TU",
      slotStartMs: t(40),
    });
  });
});

describe("formatCountdown", () => {
  // Value: protects=the countdown reads m:ss, rounded up to the second so it never says 0:00 while the turn is still ahead; fails_when=it rounds down, drops the leading zero on seconds, or goes negative; why_new=beacon watch line; seam=none; no_claim=none
  it("formats m:ss, rounding up", () => {
    expect(formatCountdown(168_000)).toBe("2:48");
    expect(formatCountdown(167_001)).toBe("2:48");
    expect(formatCountdown(59_001)).toBe("1:00");
    expect(formatCountdown(9_000)).toBe("0:09");
    expect(formatCountdown(1)).toBe("0:01");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

describe("beaconWatch", () => {
  // Listen pressed at 00:00:03, while 4U1UN had 14.100 (00:00:00–00:00:10).
  const t = (s: number) => Date.UTC(2026, 10, 18, 0, 0, 0) + s * 1000;
  const pick = { call: "4U1UN", bandIndex: 0 };
  const at = (nowS: number, audioS: number | null) =>
    beaconWatch({ pick, pickedAtMs: t(3), audioStartMs: audioS === null ? null : t(audioS), nowMs: t(nowS) });

  // Value: protects=while the picked beacon's turn on its band is on (by the server clock), the line says so; fails_when=the turn is found on the wrong band or the edge is off; why_new=beacon watch line; seam=none; no_claim=what the audio carries (it trails)
  it("is on air during the picked beacon's turn on its band", () => {
    expect(at(5, 4)).toEqual({ state: "on-air", call: "4U1UN", turnStartMs: t(0) });
    expect(at(9.999, 4)?.state).toBe("on-air");
    expect(at(180, 4)?.state).toBe("on-air");
  });

  // Value: protects=a first turn that didn't play 7 s after first audio + 1.5 s (the prompt's own rule) reads as missed until the beacon is back, with the time to its next turn; and with no audio yet it's missed too; fails_when=the first turn is called missed when it qualified, or not when it didn't; why_new=beacon watch line (owner: say so plainly); seam=none; no_claim=whether a prompt will actually come (gap, closes)
  it("says the first turn was missed when too little of it played", () => {
    // Audio at 00:00:05 counts from 00:00:06.5: 3.5 s of the turn.
    expect(at(10, 5)).toEqual({
      state: "missed",
      call: "4U1UN",
      bandKhz: 14_100,
      inMs: 170_000,
      turnStartMs: t(180),
    });
    expect(at(120, null)).toMatchObject({ state: "missed", inMs: 60_000 });
    // Exactly 7 s heard (audio at 00:00:01.5) qualifies: not missed.
    expect(at(10, 1.5)?.state).toBe("waiting");
  });

  // Value: protects=otherwise the line waits for the beacon's next turn on its band, with the countdown, and "missed" never outlives the gap after the first turn; fails_when=missed sticks after the next turn, or the countdown points at the wrong turn; why_new=beacon watch line; seam=none; no_claim=none
  it("waits for the next turn otherwise", () => {
    expect(at(10, 1)).toEqual({
      state: "waiting",
      call: "4U1UN",
      bandKhz: 14_100,
      inMs: 170_000,
      turnStartMs: t(180),
    });
    // After the second turn, even with the first missed.
    expect(at(190, 5)).toMatchObject({ state: "waiting", inMs: 170_000 });
    expect(beaconWatch({ pick: { call: "NOPE", bandIndex: 0 }, pickedAtMs: 0, audioStartMs: null, nowMs: 0 })).toBe(
      null,
    );
  });
});

describe("noQuestionReason", () => {
  const TURN = Date.UTC(2026, 10, 18, 12, 3);

  // Value: protects=the line only promises nothing when the prompt plans to ask about exactly the turn it shows; otherwise (the 10-minute gap pushed the plan to a later turn, or there's no plan: already asked on this channel, a typed receiver) it says no question this time, and after two closes it says questions are off, whatever the plan; fails_when=a countdown looks like a question is coming when the limits hold it back; why_new=owner: say when no question will come; seam=none; no_claim=the plan itself (hook tests)
  it("says why no question will follow the turn shown, if none will", () => {
    expect(noQuestionReason(TURN, TURN, false)).toBeNull();
    expect(noQuestionReason(TURN, TURN + 180_000, false)).toBe("none");
    expect(noQuestionReason(TURN, null, false)).toBe("none");
    expect(noQuestionReason(TURN, TURN, true)).toBe("off");
  });
});
