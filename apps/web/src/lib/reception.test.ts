import { describe, expect, it } from "vitest";
import { type Broadcast, listedOn, rankBroadcasts } from "./eibi";
import { SLOT_MS } from "./ibp";
import {
  BEACON_MIN_HEARD_MS,
  beaconPromptAt,
  beaconTransmitter,
  beaconWatch,
  eibiTransmitter,
  formatCountdown,
  noQuestionReason,
  signalAsk,
  signalPromptAt,
  signalTransmitter,
  STREAM_LATENCY_MS,
} from "./reception";
import { PRIYOM_ON_AIR_MS, type PriyomTx } from "./priyom-schedule";
import { findStation, type SignalStation } from "./signal-stations";

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
      askRule: 2,
    });
  });

  it.each([
    [["A", "B"], "anything from A or B", "A / B"],
    [["A", "B", "C"], "anything from A, B or C", "A / B / C"],
  ])("asks about %j together", (stations, label, name) => {
    expect(eibiTransmitter(stations.map((s) => b(s)))).toEqual({ kind: "eibi", name, label, askRule: 2 });
  });

  it("names only the nearest listing when more than three share it", () => {
    const tx = eibiTransmitter(["Near", "B", "C", "D"].map((s) => b(s)));
    expect(tx).toMatchObject({ name: "Near", label: "Near" });
  });

  // Value: protects=the prompt asks first about the station aimed where the receiver is, as the use-reception-prompt hook builds it (listedOn, then rankBroadcasts), while two or three stations are always saved under one txName in EiBi's order whatever the region, and every answer records the rule and the region it ranked by; fails_when=one channel is stored as "A / B" from one receiver and "B / A" from another, splitting #61's groups, the question still leads with a station aimed elsewhere, or the rule or region isn't recorded; why_new=#115 review (D1/D2 askRule, askRegion); seam=none; no_claim=the page passing the receiver's region (page.test)
  it("ranks the question by the receiver's region but saves the same txName", () => {
    const ask = (stations: Broadcast[], region?: "na" | "as") => {
      const listed = listedOn(stations, 5_935, Date.parse("2026-11-24T05:56:00Z"), region);
      return eibiTransmitter(listed, rankBroadcasts(listed, region), region);
    };
    const two = [b("Xizang RTV", "M", "CHN", 5_935), b("WWCR 2", "E", "NAm", 5_935)];
    for (const region of [undefined, "na", "as"] as const) {
      expect(ask(two, region)?.name).toBe("Xizang RTV / WWCR 2");
    }
    expect(ask(two, "na")?.label).toBe("anything from WWCR 2 or Xizang RTV");
    expect(ask(two)?.label).toBe("anything from Xizang RTV or WWCR 2");
    const four = [...two, b("C", "E", "Eu", 5_935), b("D", "E", "Eu", 5_935)];
    expect(ask(four, "na")).toMatchObject({ name: "WWCR 2", detail: "E/NAm", askRule: 2, askRegion: "na" });
    expect(ask(four)).toMatchObject({ name: "Xizang RTV", askRule: 2 });
    expect(ask(four)).not.toHaveProperty("askRegion");
    expect(ask(two, "as")).toMatchObject({ askRule: 2, askRegion: "as" });
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
    const why = (askSlotMs: number | null, questionsOff = false, connecting = false) =>
      noQuestionReason({ turnStartMs: TURN, askSlotMs, questionsOff, connecting, nowMs: TURN - 60_000 });
    expect(why(TURN)).toBeNull();
    expect(why(TURN + 180_000)).toBe("none");
    expect(why(null)).toBe("none");
    expect(why(TURN, true)).toBe("off");
    // Connecting: not yet known, unless questions are off anyway.
    expect(why(null, false, true)).toBe("connecting");
    expect(why(null, true, true)).toBe("off");
  });

  // Value: protects=in the STREAM_LATENCY_MS between a qualifying turn's end and its question, the line (already on the next turn) doesn't claim no question is coming; from the ask time on, an earlier planned turn reads as none again; fails_when=the note flashes for 1.5 s before the prompt appears, or the pending window never closes; why_new=#70 follow-up; seam=none; no_claim=the prompt's own timing (hook tests)
  it("says nothing while the question about the turn that just ended is on its way", () => {
    const ended = TURN - 180_000; // the planned turn, one cycle before the one shown
    const askAt = ended + SLOT_MS + STREAM_LATENCY_MS;
    const why = (nowMs: number) =>
      noQuestionReason({ turnStartMs: TURN, askSlotMs: ended, questionsOff: false, nowMs });
    expect(why(ended + SLOT_MS)).toBeNull();
    expect(why(askAt - 1)).toBeNull();
    expect(why(askAt)).toBe("none");
    // Questions off still wins.
    expect(noQuestionReason({ turnStartMs: TURN, askSlotMs: ended, questionsOff: true, nowMs: askAt - 1 })).toBe("off");
  });
});

describe("signalAsk (#101)", () => {
  const NOON = Date.UTC(2026, 10, 18, 12);
  const station = (slug: string) => findStation(slug)!;

  // Value: protects=a question is offered only for a station on the air on the dial's frequency: an always-on one on any catalog channel, a day/night one on either channel, never a defunct one or another frequency; fails_when=Listen on a station leads to a question about a frequency it isn't on, or about CHU; why_new=issue #101; seam=catalog as shipped; no_claim=the catalog's accuracy
  it("offers always-on and day/night stations on their channels only, and never a defunct one", () => {
    expect(signalAsk(station("wwv"), 15_000, null, NOON)).toEqual({
      slug: "wwv",
      name: "WWV",
      khz: 15_000,
      untilMs: Infinity,
      hint: "a man's voice",
    });
    expect(signalAsk(station("the-pip"), 3_756, null, NOON)?.untilMs).toBe(Infinity);
    expect(signalAsk(station("the-pip"), 5_448, null, NOON)?.untilMs).toBe(Infinity);
    expect(signalAsk(station("wwv"), 9_580, null, NOON)).toBeNull();
    expect(signalAsk(station("chu"), 7_850, null, NOON)).toBeNull();
  });

  // Value: protects=every catalog station is asked about within MATCH_KHZ of its frequency, the tolerance the dial names it at (#148 D10, widened by the owner to all catalog stations): The Squeaky Wheel on 3364 (EiBi's print of 3363.5), UVB-76 at 4625.3, E11 0.4 kHz off its Priyom slot; nothing past 0.5; fails_when=the dial names a station the question refuses, or the match widens past MATCH_KHZ; why_new=D10; seam=catalog as shipped; no_claim=audio heard
  it("asks about a catalog station within half a kHz of its frequency", () => {
    expect(signalAsk(station("squeaky-wheel"), 3_364, null, NOON)).toMatchObject({ slug: "squeaky-wheel", khz: 3_364 });
    expect(signalAsk(station("squeaky-wheel"), 3_364.6, null, NOON)).toBeNull();
    expect(signalAsk(station("uvb-76"), 4_625.3, null, NOON)).toMatchObject({ slug: "uvb-76" });
    expect(signalAsk(station("wwv"), 10_000.6, null, NOON)).toBeNull();
    const tx: PriyomTx = { station: "E11", startMs: NOON - 60_000, khz: 20_167, mode: "usb", summary: "E11 20167kHz USB" };
    expect(signalAsk(station("e11"), 20_167.4, [tx], NOON)).toMatchObject({ slotStartMs: tx.startMs });
    expect(signalAsk(station("e11"), 20_167.6, [tx], NOON)).toBeNull();
  });

  // Value: protects=a numbers station is offered only while Priyom lists it on the air on that frequency, carrying the transmission's start and ending PRIYOM_ON_AIR_MS after it; with no schedule, nothing; fails_when=a question is planned without a slot for the server to check, past the estimated end, or on last month's frequency; why_new=issue #101 (exact-slot check); seam=none; no_claim=Priyom's accuracy
  it("offers a numbers station inside Priyom's transmission on its frequency", () => {
    const tx: PriyomTx = { station: "E11", startMs: NOON - 60_000, khz: 20_167, mode: "usb", summary: "E11 20167kHz USB" };
    expect(signalAsk(station("e11"), 20_167, [tx], NOON)).toEqual({
      slug: "e11",
      name: "E11",
      khz: 20_167,
      untilMs: tx.startMs + PRIYOM_ON_AIR_MS,
      slotStartMs: tx.startMs,
    });
    expect(signalAsk(station("e11"), 20_167, null, NOON)).toBeNull();
    expect(signalAsk(station("e11"), 18_000, [tx], NOON)).toBeNull();
    expect(signalAsk(station("e11"), 20_167, [tx], tx.startMs + PRIYOM_ON_AIR_MS)).toBeNull();
  });

  // Value: protects=a scheduled window counts only while it's open and on its own channel, ending at the window's end; fails_when=a windows station (none in the catalog yet) is asked about outside its window; why_new=issue #101; seam=a made-up station; no_claim=none
  it("offers a windows station only inside its window, on its channel", () => {
    const s: SignalStation = {
      ...station("wwv"),
      slug: "test",
      channels: [{ khz: 6_000, mode: "usb" }, { khz: 7_000, mode: "usb" }],
      schedule: { kind: "windows", windows: [{ startUtc: 11 * 60, endUtc: 13 * 60, khz: 7_000 }] },
    };
    expect(signalAsk(s, 7_000, null, NOON)?.untilMs).toBe(NOON + 60 * 60_000);
    expect(signalAsk(s, 6_000, null, NOON)).toBeNull();
    expect(signalAsk(s, 7_000, null, NOON + 2 * 60 * 60_000)).toBeNull();
  });

  // Value: protects=a station with no transmitter location is never offered a question, on any channel or schedule (the server's signalChecks relies on this too); fails_when=the tx guard is dropped and reports about a station the page can't rank by path are asked and stored; why_new=every catalog station tested so far has a transmitter or is defunct; seam=a made-up station; no_claim=none
  it("offers nothing for a station with no transmitter", () => {
    const s: SignalStation = { ...station("wwv"), slug: "no-tx", tx: undefined };
    expect(signalAsk(s, 10_000, null, NOON)).toBeNull();
  });
});

describe("signalPromptAt (#101)", () => {
  const ask = { slug: "e11", name: "E11", khz: 20_167, untilMs: 200_000 };

  // Value: protects=the question comes after the dwell counted from first audio plus the stream's lag, waits for the gap between questions, and is dropped when either would land after the station goes off; fails_when=a question about dead air is asked, or one is asked early; why_new=issue #101 (beacon rule's counting); seam=none; no_claim=none
  it("asks after the dwell from first audio plus the lag, never after the station is off", () => {
    expect(signalPromptAt(ask, 0, 0, 60_000)).toBe(STREAM_LATENCY_MS + 60_000);
    expect(signalPromptAt(ask, 0, 100_000, 60_000)).toBe(100_000);
    expect(signalPromptAt(ask, 0, 200_001, 60_000)).toBeNull();
    expect(signalPromptAt(ask, 200_000 - 60_000 - STREAM_LATENCY_MS, 0, 60_000)).toBe(200_000);
    expect(signalPromptAt(ask, 200_000 - 60_000 - STREAM_LATENCY_MS + 1, 0, 60_000)).toBeNull();
  });
});

describe("signalTransmitter (#101)", () => {
  const NOON = Date.UTC(2026, 10, 18, 12);
  const ask = (slug: string, khz: number) => signalAsk(findStation(slug)!, khz, null, NOON)!;

  // Value: protects=WWV and WWVH, which share 2.5-15 MHz, are each asked about with the voice that tells them apart, while the answer is still stored under the slug alone; a station with no partner keeps its plain name; fails_when=a listener who picked WWV but hears WWVH has nothing to go on and answers "heard", so #102's badge marks WWV heard on WWVH's strength; why_new=review of #101 (WWV answers may really be WWVH); seam=catalog as shipped; no_claim=that listeners read the hint
  it("adds the voice that tells WWV from WWVH to the question, not to what's stored", () => {
    expect(signalTransmitter(ask("wwv", 10_000))).toEqual({ kind: "signal", name: "wwv", detail: "10000", label: "WWV (a man's voice)" });
    expect(signalTransmitter(ask("wwvh", 10_000)).label).toBe("WWVH (a woman's voice)");
    expect(signalTransmitter(ask("uvb-76", 4_625)).label).toBe("UVB-76");
  });
});
