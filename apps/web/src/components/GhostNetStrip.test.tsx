// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Occurrence } from "@/lib/ghostnet";
import type { Mode } from "@/lib/radio-types";
import { GhostNetStrip, type GhostPick } from "./GhostNetStrip";

// The server's time the strip sees: useServerTick rounds down to its step and is null while disabled.
let nowMs = 0;
// False until the page has a server time (useServerTick returns null then).
let clockKnown = true;
vi.mock("@/lib/use-server-tick", () => ({
  useServerTick: (step: number, enabled = true) => (enabled && clockKnown ? nowMs - (nowMs % step) : null),
}));

afterEach(() => {
  cleanup();
  clockKnown = true;
});

const at = (iso: string) => Date.parse(iso);
// The North America net picked with Listen; its window ends Fri 03:00 UTC.
const NA_PICK = { eventId: "na", endMs: Date.parse("2026-11-27T03:00:00Z") };

function renderStrip(
  iso: string,
  props: {
    open?: boolean;
    freqKhz?: number;
    mode?: Mode;
    pick?: GhostPick | null;
    connecting?: boolean;
    playing?: boolean;
    onListen?: (o: Occurrence) => void;
  } = {},
) {
  nowMs = at(iso);
  const all = {
    open: props.open ?? true,
    onOpenChange: () => {},
    freqKhz: props.freqKhz ?? 9420,
    mode: props.mode ?? ("am" as Mode),
    pick: props.pick ?? null,
    connecting: props.connecting ?? false,
    playing: props.playing ?? false,
    onListen: props.onListen ?? (() => {}),
  };
  const view = render(<GhostNetStrip {...all} />);
  return { ...view, rerenderAt: (next: string, over: Partial<typeof all> = {}) => {
    nowMs = at(next);
    view.rerender(<GhostNetStrip {...all} {...over} />);
  } };
}

const tables = () => screen.getAllByRole("table");
const listens = () => screen.queryAllByRole("button", { name: /^Listen to/ });

describe("GhostNetStrip", () => {
  // Value: protects=with nothing on the air (most of the week) the strip says so and names the next window, lists one Next row per net and bridge, and offers no Listen days ahead (D7, D9, D13); fails_when=On now disappears, Next misses or repeats an event, or Listen shows far from a window; why_new=new component; seam=useServerTick mocked; no_claim=local time text (device zone)
  it("says nothing is on and lists each event's next opening", () => {
    renderStrip("2026-11-25T12:00:00Z");
    expect(screen.getByText(/^Nothing on the air now\. Next: Australia net, Thu 0700 UTC \(in 19h 0m\)\.$/)).toBeTruthy();
    expect(tables()).toHaveLength(1);
    expect(within(tables()[0]!).getAllByRole("row")).toHaveLength(7);
    expect(listens()).toHaveLength(0);
    expect(screen.getByText(/· next in 19h 0m/)).toBeTruthy();
  });

  // Value: protects=an on-air JS8 slot shows its time left, the next slot, the tuned marker and the tones note while tuned, and a Listen named for the net and dial that reports its occurrence (D4, D15); fails_when=the note shows untuned, the name drops mode or frequency, or the click reports another row; why_new=new component; seam=useServerTick mocked; no_claim=Pick best
  it("shows the on-air slot with its note while tuned, and Listen tunes it", () => {
    const onListen = vi.fn();
    renderStrip("2026-11-27T01:10:00Z", { freqKhz: 7107, mode: "usb", onListen });
    const row = within(tables()[0]!).getByRole("rowheader", { name: /7\.107/ }).closest("tr")!;
    expect(row.hasAttribute("data-current")).toBe(true);
    expect(within(row).getByText("20:00 left")).toBeTruthy();
    expect(screen.getByText("JS8Call data: you'll hear tones. Skywave can't decode them yet.")).toBeTruthy();
    expect(screen.getByText(/Next slot: Winlink VARA, 7\.107, in 20:00/)).toBeTruthy();
    expect(screen.getByText(/· North America net on now/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Listen to North America net, JS8Call on 7.107 MHz USB" }));
    expect(onListen).toHaveBeenCalledOnce();
    expect(onListen.mock.calls[0]![0]).toMatchObject({ event: { id: "na" }, startMs: at("2026-11-27T01:00:00Z") });
  });

  // Value: protects=no tones note when the dial is elsewhere; fails_when=the note ignores the tuned check; why_new=D4/D14 note rule; seam=useServerTick mocked; no_claim=none beyond protects
  it("leaves the note off when not tuned", () => {
    renderStrip("2026-11-27T01:10:00Z", { freqKhz: 7107.2, mode: "usb" });
    expect(screen.queryByText(/you'll hear tones/)).toBeNull();
  });

  // Value: protects=with the dial on 7.107 USB during the VARA slot, only the on-air row explains the audio ("Can't be decoded here"), though Next rows on 7.107 USB are tuned too (D14); fails_when=notes key on tuned alone and contradict; why_new=owner D14; seam=useServerTick mocked; no_claim=none beyond protects
  it("explains the audio only on the on-air row", () => {
    renderStrip("2026-11-27T01:40:00Z", { freqKhz: 7107, mode: "usb" });
    expect(screen.getAllByText("Can't be decoded here.")).toHaveLength(1);
    expect(screen.queryByText(/you'll hear tones/)).toBeNull();
    const tunedNext = within(tables()[1]!).getAllByRole("row").filter((r) => r.hasAttribute("data-current"));
    expect(tunedNext.length).toBeGreaterThan(0);
  });

  // Value: protects=Listen shows on a Next row from 15 minutes before it opens, not 16 (D9); fails_when=the lead is off by a minute; why_new=owner D9; seam=useServerTick mocked; no_claim=none beyond protects
  it.each([
    ["2026-11-26T06:44:00Z", 0],
    ["2026-11-26T06:45:00Z", 1],
  ])("at %s offers %i Listen", (iso, count) => {
    renderStrip(iso);
    expect(listens()).toHaveLength(count);
  });

  // Value: protects=an ALE window has no Listen and lists the channels it hops, saying it can't be decoded; fails_when=ALE gets a Listen or the channels go missing; why_new=issue #91 ALE rule; seam=useServerTick mocked; no_claim=none beyond protects
  it("lists ALE channels without a Listen", () => {
    renderStrip("2026-11-28T19:10:00Z");
    expect(screen.getByText(/^Hops 10 USB channels: 3\.5985, 7\.1045.*28\.1085 MHz\. Can't be decoded here\.$/)).toBeTruthy();
    expect(within(tables()[0]!).queryByRole("button")).toBeNull();
  });

  // Value: protects=the RTTY Listen names the guide's 7.077 and the dial it really tunes (D8, D15); fails_when=the label hides that the dial differs; why_new=owner D8; seam=useServerTick mocked; no_claim=whether 7.077 is the mark
  it("names the RTTY dial", () => {
    renderStrip("2026-11-27T02:05:00Z");
    expect(screen.getByRole("button", { name: "Listen to North America net, RTTY on 7.077 MHz, dial 7.0749 USB" })).toBeTruthy();
  });

  // Value: protects=after Listen the picked row's button reads pressed and its line says "Connecting…" until audio (D8); fails_when=the pick isn't matched to its row or connecting is ignored; why_new=owner D8; seam=useServerTick mocked; no_claim=page wiring
  it("marks the picked row and says Connecting…", () => {
    renderStrip("2026-11-27T01:10:00Z", {
      freqKhz: 7107,
      mode: "usb",
      connecting: true,
      pick: NA_PICK,
    });
    expect(screen.getByRole("button", { name: /North America net, JS8Call/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Connecting…")).toBeTruthy();
  });

  // Value: protects=a net stays picked when it rolls into its next slot on the same dial (JS8 to VARA, both 7.107 USB), so Listen keeps reading pressed (review C1); fails_when=the pick is matched by slot start time; why_new=quality review finding; seam=useServerTick mocked; no_claim=page wiring
  it("keeps the picked net pressed across a slot on the same dial", () => {
    renderStrip("2026-11-27T01:40:00Z", { freqKhz: 7107, mode: "usb", pick: NA_PICK });
    expect(screen.getByRole("button", { name: /North America net, Winlink VARA/ }).getAttribute("aria-pressed")).toBe("true");
  });

  // Value: protects=an on-air row with nothing to say (last slot, not tuned) gets no empty line under it (review C2); fails_when=the note row renders unconditionally; why_new=quality review finding; seam=useServerTick mocked; no_claim=none beyond protects
  it("adds no note line when there's nothing to say", () => {
    renderStrip("2026-11-27T02:40:00Z");
    expect(document.querySelector(".ghostnet-note-row")).toBeNull();
  });

  // Value: protects=the hidden status line speaks when a window starts and ends, never the ticking countdowns (D13); fails_when=the line repeats every tick or misses a start; why_new=owner D13; seam=useServerTick mocked; no_claim=what a given screen reader does
  it("announces a window starting and ending only", () => {
    const view = renderStrip("2026-11-27T00:59:00Z");
    const status = () => screen.getByRole("status").textContent;
    expect(status()).toBe("");
    view.rerenderAt("2026-11-27T00:59:30Z");
    expect(status()).toBe("");
    view.rerenderAt("2026-11-27T01:00:00Z");
    expect(status()).toBe("North America net on the air now.");
    view.rerenderAt("2026-11-27T03:00:00Z");
    expect(status()).toBe("North America net ended.");
  });

  // Value: protects=the hidden status line says "Connecting…" when the picked net's receiver starts connecting, then "<net> playing." once audio plays (D8, D13); fails_when=the pick's state changes aren't announced, or playing is announced for a net not on the air or as Connecting…; why_new=audit: only window start/end announcements were tested; seam=useServerTick mocked; no_claim=what a given screen reader does
  it("announces the picked net connecting, then playing", () => {
    const tuned = { freqKhz: 7107, mode: "usb" as Mode, pick: NA_PICK };
    const view = renderStrip("2026-11-27T01:10:00Z", tuned);
    const status = () => screen.getByRole("status").textContent;
    expect(status()).toBe("");
    view.rerenderAt("2026-11-27T01:10:00Z", { ...tuned, connecting: true });
    expect(status()).toBe("Connecting…");
    view.rerenderAt("2026-11-27T01:10:01Z", { ...tuned, connecting: false, playing: true });
    expect(status()).toBe("North America net playing.");
  });

  // Value: protects=reopening the strip only records what's on; a window that started while it was folded isn't announced as news (D13); fails_when=closing keeps the last snapshot, so reopening reads a stale diff aloud; why_new=audit: the reopen rule in useAnnouncements had no test; seam=useServerTick mocked (null while folded); no_claim=what a given screen reader does
  it("says nothing on reopening after a window started while folded", () => {
    const view = renderStrip("2026-11-27T00:59:00Z");
    const status = () => screen.getByRole("status").textContent;
    view.rerenderAt("2026-11-27T01:05:00Z", { open: false });
    view.rerenderAt("2026-11-27T01:10:00Z", { open: true });
    expect(screen.getByText(/· North America net on now/)).toBeTruthy();
    expect(status()).toBe("");
  });

  // Value: protects=folded, the strip shows only its summary with the status tail (D6), no rows; fails_when=the body renders closed or the tail needs the strip open; why_new=owner D6; seam=useServerTick mocked; no_claim=details element toggling in a browser
  it("keeps the summary status while folded", () => {
    renderStrip("2026-11-27T01:10:00Z", { open: false });
    expect(screen.queryAllByRole("table")).toHaveLength(0);
    expect(screen.getByText(/· North America net on now/)).toBeTruthy();
  });
  // Value: protects=the strip credits S2 Underground with a link to the GhostNet repository, the attribution CC BY-NC-SA 4.0 requires (issue #91); fails_when=the credit or its link is dropped or pointed elsewhere; why_new=plan Section 3 listed the credit link (/ship plan audit); seam=useServerTick mocked; no_claim=the licence's other terms
  it("credits S2 Underground with a link", () => {
    renderStrip("2026-11-25T12:00:00Z");
    const link = screen.getByRole("link", { name: "S2 Underground" });
    expect(link.getAttribute("href")).toBe("https://github.com/s2underground/GhostNet");
    expect(link.closest("p")!.textContent).toMatch(/GhostNet schedule by S2 Underground\.$/);
  });

  // Value: protects=open, the strip renders no rows, times or Listen until the page has a server time (as BeaconStrip), keeping its summary and credit; fails_when=Body renders with a null or zero clock and shows a 1970 schedule; why_new=plan Section 3 listed it (/ship plan audit); seam=useServerTick mocked; no_claim=how long the clock takes in a browser
  it("shows no rows until the clock has a time", () => {
    clockKnown = false;
    renderStrip("2026-11-27T01:10:00Z");
    expect(screen.queryAllByRole("table")).toHaveLength(0);
    expect(screen.queryByText("On now")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("GhostNet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "S2 Underground" })).toBeTruthy();
  });
  // Value: protects=pressing the picked row's Listen again does nothing while its receiver connects or plays, so a stray second press can't restart Pick best and cut the audio or abandon the connect (review D9); fails_when=the press guard is dropped or busy stops counting connecting; why_new=owner D9 (audio cut), connecting row from ship coverage audit; seam=useServerTick mocked; no_claim=the beacon strip, which keeps its re-pick
  it.each([
    ["plays", { playing: true }],
    ["connects", { connecting: true }],
  ] as const)("ignores a second press on the picked Listen while it %s", (_state, state) => {
    const onListen = vi.fn();
    renderStrip("2026-11-27T01:10:00Z", { freqKhz: 7107, mode: "usb", pick: NA_PICK, ...state, onListen });
    const listen = screen.getByRole("button", { name: "Listen to North America net, JS8Call on 7.107 MHz USB" });
    expect(listen.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(listen);
    expect(onListen).not.toHaveBeenCalled();
  });

  // Value: protects=after Stop or a run that never started (nothing connecting or playing), the picked row's Listen still listens again, so the D9 guard never leaves a dead Listen (review fix-check 2); fails_when=the guard ignores a picked row regardless of whether anything plays; why_new=fix-check found Listen dead after Stop; seam=useServerTick mocked; no_claim=page wiring of Stop (page passes playing/connecting from radio status)
  it("listens again on the picked row once nothing plays", () => {
    const onListen = vi.fn();
    renderStrip("2026-11-27T01:10:00Z", { freqKhz: 7107, mode: "usb", pick: NA_PICK, onListen });
    fireEvent.click(screen.getByRole("button", { name: "Listen to North America net, JS8Call on 7.107 MHz USB" }));
    expect(onListen).toHaveBeenCalledOnce();
  });

  // Value: protects=a double-click on a Listen not yet picked starts one run, not two (the second click arrives with detail 2), so the second can't restart Pick best on the receiver the first is connecting; fails_when=the e.detail guard is dropped; why_new=only the picked-row guard was tested; seam=useServerTick mocked; no_claim=how a browser numbers clicks
  it("ignores the second click of a double-click on Listen", () => {
    const onListen = vi.fn();
    renderStrip("2026-11-27T01:10:00Z", { onListen });
    const listen = screen.getByRole("button", { name: "Listen to North America net, JS8Call on 7.107 MHz USB" });
    fireEvent.click(listen, { detail: 1 });
    fireEvent.click(listen, { detail: 2 });
    expect(onListen).toHaveBeenCalledOnce();
  });
});
