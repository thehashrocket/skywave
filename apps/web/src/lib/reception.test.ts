import { describe, expect, it } from "vitest";
import type { Broadcast } from "./eibi";
import {
  BEACON_MIN_HEARD_MS,
  beaconPromptAt,
  beaconTransmitter,
  eibiTransmitter,
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
    expect(beaconPromptAt(pick, t(1), 0)).toBe(t(10) + STREAM_LATENCY_MS);
    // Audio at 1.5 s, heard from 3 s: exactly 7 s counts.
    expect(beaconPromptAt(pick, t(1.5), 0)).toBe(t(10) + STREAM_LATENCY_MS);
    // Audio before the slot: all of it.
    expect(beaconPromptAt(pick, t(-30), 0)).toBe(t(10) + STREAM_LATENCY_MS);
  });

  // Value: protects=too little of the slot left means no question this time, but the same pick qualifies on its next turn on the band 3 minutes later; fails_when=a short slot is asked about, or the next turn is computed wrong; why_new=beacon prompt (owner rule); seam=none; no_claim=none
  it("skips a slot with less than 7 s heard and waits for the beacon's next turn", () => {
    // Audio at 1.6 s, heard from 3.1 s: 6.9 s.
    expect(beaconPromptAt(pick, t(1.6), 0)).toBe(t(180 + 10) + STREAM_LATENCY_MS);
    // Audio after the slot ended entirely.
    expect(beaconPromptAt(pick, t(20), 0)).toBe(t(180 + 10) + STREAM_LATENCY_MS);
  });

  // Value: protects=the slot is the picked beacon's on the picked band (it reaches band b at its own slot plus b), and the prompt gap pushes it to a later turn; fails_when=the band offset is applied the wrong way, or the gap is ignored; why_new=beacon prompt; seam=none; no_claim=none
  it("finds the beacon's turn on its band, and waits out the prompt gap", () => {
    // 4U1UN reaches 21.150 (band 2) at 00:00:20.
    expect(beaconPromptAt({ call: "4U1UN", bandIndex: 2 }, t(0), 0)).toBe(t(30) + STREAM_LATENCY_MS);
    // YV5B, last in the list, is on 18.110 (band 1) in the first slot.
    expect(beaconPromptAt({ call: "YV5B", bandIndex: 1 }, t(0), 0)).toBe(t(10) + STREAM_LATENCY_MS);
    expect(beaconPromptAt(pick, t(1), t(200))).toBe(t(360 + 10) + STREAM_LATENCY_MS);
    expect(beaconPromptAt({ call: "NOPE", bandIndex: 0 }, t(0), 0)).toBeNull();
  });

  // Value: protects=the stored report names the beacon by callsign and its band as the detail (schema.prisma's txDetail); fails_when=the shape drifts from what the server checks; why_new=beacon prompt; seam=none; no_claim=none
  it("names the beacon and its band", () => {
    expect(beaconTransmitter({ call: "4X6TU", bandIndex: 4 })).toEqual({
      kind: "beacon",
      name: "4X6TU",
      detail: "28200",
      label: "4X6TU",
    });
  });
});
