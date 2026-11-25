// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PriyomTx } from "@/lib/priyom-schedule";
import type { Mode } from "@/lib/radio-types";
import type { LastHeard } from "@/lib/signal-heard";
import { SignalStations } from "./SignalStations";

// The server's time the panel sees: useServerTick rounds down to its step; null before the page knows it.
let nowMs = 0;
let clockKnown = true;
vi.mock("@/lib/use-server-tick", () => ({
  useServerTick: (step: number, enabled = true) => (enabled && clockKnown ? nowMs - (nowMs % step) : null),
}));

afterEach(() => {
  cleanup();
  clockKnown = true;
});

const tx = (station: string, iso: string, khz: number): PriyomTx => ({
  station,
  startMs: Date.parse(iso),
  khz,
  mode: "usb",
  summary: `${station} ${khz}kHz USB`,
});

function renderPanel(
  iso: string,
  props: {
    priyom?: readonly PriyomTx[] | null;
    heard?: Record<string, LastHeard> | null;
    freqKhz?: number;
    mode?: Mode;
    picked?: string | null;
    connecting?: boolean;
    playing?: boolean;
  } = {},
) {
  nowMs = Date.parse(iso);
  const onListen = vi.fn();
  const panel = (p: typeof props) => (
    <SignalStations
      freqKhz={p.freqKhz ?? 9420}
      mode={p.mode ?? "am"}
      priyom={p.priyom ?? null}
      heard={p.heard ?? null}
      picked={p.picked ?? null}
      connecting={p.connecting ?? false}
      playing={p.playing ?? false}
      onListen={onListen}
    />
  );
  const view = render(panel(props));
  return {
    onListen,
    /** Re-render at another time and/or with other props, as the page would. */
    rerenderAt: (next: string, over: typeof props = {}) => {
      nowMs = Date.parse(next);
      view.rerender(panel({ ...props, ...over }));
    },
  };
}

const status = () => screen.getByRole("status").textContent;

const heads = () => [...document.querySelectorAll(".signals .sched-head")].map((e) => e.textContent);
const rowOf = (name: string) => screen.getAllByRole("row").find((r) => within(r).queryByText(name, { exact: true }))!;

describe("SignalStations", () => {
  // Value: protects=with nothing scheduled on (no Priyom schedule), the panel still shows Always on with Listen on every row, the numbers stations under Later with "Schedule unavailable, check Priyom" and no Listen, and Priyom's credit (#100 acceptance: the empty state never looks empty); fails_when=the panel renders blank, a numbers row offers Listen with no frequency, or the credit is missing; why_new=#100 panel; seam=useServerTick mocked; no_claim=layout
  it("shows Always on and Later when nothing scheduled is on", () => {
    renderPanel("2026-11-25T07:00:00Z");
    expect(heads()).toEqual(["Always on", "Later"]);
    expect(within(rowOf("UVB-76")).getByRole("button", { name: "Listen to UVB-76 on 4.625 USB" })).toBeTruthy();
    const e11 = rowOf("E11");
    expect(within(e11).queryByRole("button")).toBeNull();
    expect(e11.textContent).toContain("Schedule unavailable");
    expect(within(e11).getByRole("link", { name: "check Priyom" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Priyom.org" })).toBeTruthy();
  });

  // Value: protects=a Priyom slot on the air shows under On now with its frequency, the time left, and a Listen that hands the page the station and that channel (#100 acceptance: on-now state); fails_when=on-now rows are missing, show the wrong frequency, or Listen passes the wrong channel; why_new=#100 panel; seam=useServerTick mocked, onListen; no_claim=Pick best
  it("lists a station on now with the time left, and Listen tunes it", () => {
    const { onListen } = renderPanel("2026-11-25T07:17:00Z", { priyom: [tx("E11", "2026-11-25T07:15:00Z", 20_167)] });
    expect(heads()[0]).toBe("On now");
    const row = rowOf("E11");
    expect(row.textContent).toContain("20.167 USB");
    expect(row.textContent).toContain("8 min left");
    fireEvent.click(within(row).getByRole("button", { name: "Listen to E11 on 20.167 USB" }), { detail: 1 });
    expect(onListen).toHaveBeenCalledWith(expect.objectContaining({ slug: "e11" }), { khz: 20_167, mode: "usb" });
  });

  // Value: protects=defunct stations sit in a folded History with no Listen button anywhere in their rows (#100 acceptance: Listen on a defunct station is impossible); fails_when=a defunct row renders Listen, or History isn't folded; why_new=#100 panel; seam=useServerTick mocked; no_claim=none
  it("folds history and never offers Listen there", () => {
    renderPanel("2026-11-25T07:00:00Z");
    const history = screen.getByText(/^History \(3\)$/).closest("details")!;
    expect(history.open).toBe(false);
    for (const name of ["CHU", "Lincolnshire Poacher", "Cherry Ripe"]) {
      const row = within(history).getAllByRole("row").find((r) => within(r).queryByText(name, { exact: true }))!;
      expect(within(row).queryByRole("button")).toBeNull();
    }
    expect(history.textContent).toContain("Off the air since 2008-07");
  });

  // Value: protects=the picked station's row is marked pressed while the dial is on it, and pressing its Listen again while it plays doesn't restart Pick best (which could cut the audio); fails_when=the pick isn't shown, or a re-press restarts the run; why_new=#100 panel (same guard as GhostNet); seam=onListen; no_claim=none
  it("marks the picked station and ignores a re-press while playing", () => {
    const { onListen } = renderPanel("2026-11-25T07:00:00Z", { freqKhz: 4625, mode: "usb", picked: "uvb-76", playing: true });
    const button = within(rowOf("UVB-76")).getByRole("button", { name: /^Listen to UVB-76/ });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button, { detail: 1 });
    expect(onListen).not.toHaveBeenCalled();
  });

  // Value: protects=before the page knows the server's time, no rows (and no countdowns or Listen) render, only the heading and credit; fails_when=rows render from the device's clock; why_new=#100 panel; seam=useServerTick mocked; no_claim=none
  it("renders no rows until the clock is known", () => {
    clockKnown = false;
    renderPanel("2026-11-25T07:00:00Z");
    expect(screen.getByRole("heading", { name: "Signal stations" })).toBeTruthy();
    expect(screen.queryAllByRole("table")).toEqual([]);
  });

  // Value: protects=after the listener changes mode on the picked station's frequency, its row still counts as picked, so a second Listen while it connects can't restart Pick best and cut the connection (owner: anything that could end audio is fixed); fails_when=the picked test requires the mode to match; why_new=#100 review finding 5; seam=onListen; no_claim=none
  it("keeps the picked station's guard after a mode change", () => {
    const { onListen } = renderPanel("2026-11-25T07:00:00Z", { freqKhz: 4625, mode: "am", picked: "uvb-76", connecting: true });
    const button = within(rowOf("UVB-76")).getByRole("button", { name: /^Listen to UVB-76/ });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button, { detail: 1 });
    expect(onListen).not.toHaveBeenCalled();
  });

  // Value: protects=stations the listener didn't pick come on and go off the air in silence: the section is always on the page and Priyom lists dozens of slots a day, so announcing them would interrupt a screen-reader user all visit (owner, after #124 shipped); fails_when=every station's start or end is spoken again; why_new=accessibility fix after #124; seam=useServerTick mocked; no_claim=what a screen reader does with the text
  it("says nothing when a station nobody picked comes on or goes off", () => {
    const priyom = [tx("E11", "2026-11-25T07:15:00Z", 20_167)];
    const { rerenderAt } = renderPanel("2026-11-25T07:10:00Z", { priyom });
    rerenderAt("2026-11-25T07:16:00Z");
    expect(rowOf("E11").textContent).toContain("left");
    rerenderAt("2026-11-25T07:30:00Z");
    expect(status()).toBe("");
  });

  // Value: protects=the picked station's own slot starting and ending, and its run connecting then playing, are still announced; fails_when=the fix silences the picked station too, or a first Listen's "Connecting…" is lost because the pick is new; why_new=accessibility fix after #124; seam=useServerTick mocked; no_claim=what a screen reader does with the text
  it("announces only the picked station's slot and its connecting and playing", () => {
    const priyom = [tx("E11", "2026-11-25T07:15:00Z", 20_167)];
    const dial = { freqKhz: 20_167, mode: "usb" as Mode };
    const { rerenderAt } = renderPanel("2026-11-25T07:10:00Z", { priyom, ...dial });
    rerenderAt("2026-11-25T07:11:00Z", { ...dial, picked: "e11", connecting: true });
    expect(status()).toBe("Connecting…");
    rerenderAt("2026-11-25T07:12:00Z", { ...dial, picked: "e11", connecting: false, playing: true });
    expect(status()).toBe("Playing.");
    rerenderAt("2026-11-25T07:16:00Z", { ...dial, picked: "e11", playing: true });
    expect(status()).toBe("E11 on the air now.");
    rerenderAt("2026-11-25T07:30:00Z", { ...dial, picked: "e11", playing: true });
    expect(status()).toBe("E11 ended.");
  });

  // Value: protects=after a failed connect the line is cleared, so pressing Listen again speaks "Connecting…" anew instead of leaving an unchanged live region that screen readers skip; fails_when=the old text stays and the retry is silent; why_new=/ship review of #125; seam=useServerTick mocked; no_claim=what a screen reader does with the text
  it("clears the line when the run goes idle, so a retry is spoken again", () => {
    const { rerenderAt } = renderPanel("2026-11-25T07:10:00Z");
    rerenderAt("2026-11-25T07:11:00Z", { picked: "uvb-76", connecting: true });
    expect(status()).toBe("Connecting…");
    rerenderAt("2026-11-25T07:12:00Z", { picked: "uvb-76" });
    expect(status()).toBe("");
    rerenderAt("2026-11-25T07:13:00Z", { picked: "uvb-76", connecting: true });
    expect(status()).toBe("Connecting…");
  });

  // Value: protects=a slot of the picked station on another frequency than the dial's isn't announced as on the air, since the listener hears silence there; fails_when=the station counts as on the air whatever its slot's frequency; why_new=/ship review of #125; seam=useServerTick mocked; no_claim=none
  it("doesn't announce the picked station's slot on another frequency", () => {
    const priyom = [tx("E11", "2026-11-25T07:15:00Z", 9_150)];
    const dial = { freqKhz: 20_167, mode: "usb" as Mode, picked: "e11" };
    const { rerenderAt } = renderPanel("2026-11-25T07:10:00Z", { priyom, ...dial });
    rerenderAt("2026-11-25T07:16:00Z", dial);
    expect(status()).toBe("");
  });

  // Value: protects=pressing Listen on a new station while another plays says nothing until the new run is connecting, never an early "Playing." that's still the old receiver; fails_when=a new pick announces the current phase whatever it is; why_new=/ship review of #125; seam=useServerTick mocked; no_claim=none
  it("doesn't say Playing for a new pick before it connects", () => {
    const { rerenderAt } = renderPanel("2026-11-25T07:10:00Z", { picked: "uvb-76", playing: true });
    rerenderAt("2026-11-25T07:11:00Z", { picked: "the-pip", playing: true });
    expect(status()).toBe("");
    rerenderAt("2026-11-25T07:12:00Z", { picked: "the-pip", connecting: true });
    expect(status()).toBe("Connecting…");
  });

  // Value: protects=folding the section hides its tables but not the status line, so the picked station's "Connecting…" is still spoken, and the folded heading summarises what's on ("6 always on"); fails_when=the live region sits inside the folded body and goes silent, or no summary shows; why_new=collapsible sections; seam=useServerTick mocked; no_claim=what a screen reader does with the text
  it("keeps speaking the picked station while folded", () => {
    nowMs = Date.parse("2026-11-25T07:10:00Z");
    const fold = { folded: true, onToggle: () => {} };
    const props = { fold, freqKhz: 4625, mode: "usb" as Mode, priyom: null, onListen: () => {} };
    const view = render(<SignalStations {...props} picked={null} />);
    expect(document.getElementById("signal-stations-body")!.hidden).toBe(true);
    expect(screen.getByText(/6 always on/)).toBeTruthy();
    nowMs = Date.parse("2026-11-25T07:11:00Z");
    view.rerender(<SignalStations {...props} picked="uvb-76" connecting />);
    expect(status()).toBe("Connecting…");
  });

  // Value: protects=#102 badge: a station heard this week shows "heard N ago" in its row, a shared WWV/WWVH frequency reads "WWV or WWVH heard", a station heard today moves to the top of Always on, and a station with no heard time shows no badge; fails_when=the badge is missing or on the wrong row, the shared wording is lost, or the order ignores reports; why_new=#102 panel badge; seam=useServerTick mocked, heard passed as the query would return it; no_claim=layout
  it("shows when listeners last heard a station and lists today's first", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    const ago = (min: number) => now - min * 60_000;
    renderPanel("2026-11-25T12:00:00Z", {
      heard: {
        "uvb-76": { heardMs: ago(40), either: null, heard24h: 1, notHeard24h: 0 },
        wwv: { heardMs: ago(125), either: ["WWV", "WWVH"], heard24h: 0, notHeard24h: 0 },
        wwvh: { heardMs: ago(125), either: ["WWV", "WWVH"], heard24h: 1, notHeard24h: 0 },
        rwm: { heardMs: null, either: null, heard24h: 0, notHeard24h: 2 },
      },
    });
    expect(rowOf("UVB-76").textContent).toContain("heard 40 min ago");
    expect(rowOf("WWV").textContent).toContain("WWV or WWVH heard 2h 5m ago");
    expect(rowOf("WWVH").textContent).toContain("WWV or WWVH heard 2h 5m ago");
    expect(rowOf("RWM").textContent).not.toContain("heard");
    const always = [...document.querySelectorAll(".signals tr[data-slug]")].map((r) => r.getAttribute("data-slug"));
    expect(always.slice(0, 4)).toEqual(["uvb-76", "wwv", "wwvh", "rwm"]);
  });

  // Value: protects=#102 On now also lists the stations listeners confirmed in the last day first (a report beats the schedule), while unconfirmed rows stay ending-soonest first; fails_when=withHeard reorders only Always on, so a heard numbers station stays below one ending sooner; why_new=the existing badge test only checks Always on and confirmedFirst's unit test is given Always on rows; seam=useServerTick mocked, heard passed as the query would return it; no_claim=layout
  it("lists a station heard today first under On now", () => {
    const priyom = [tx("E07", "2026-11-25T07:12:00Z", 9_150), tx("E11", "2026-11-25T07:15:00Z", 20_167)];
    const onNow = () => [...document.querySelectorAll(".signals tr[data-slug]")].map((r) => r.getAttribute("data-slug")).slice(0, 2);
    const at = "2026-11-25T07:17:00Z";
    renderPanel(at, { priyom });
    expect(heads()[0]).toBe("On now");
    expect(onNow()).toEqual(["e07", "e11"]);
    cleanup();
    const heardMs = Date.parse(at) - 30 * 60_000;
    renderPanel(at, { priyom, heard: { e11: { heardMs, either: null, heard24h: 1, notHeard24h: 0 } } });
    expect(onNow()).toEqual(["e11", "e07"]);
    expect(rowOf("E11").textContent).toContain("heard 30 min ago");
  });
});
