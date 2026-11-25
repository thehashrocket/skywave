// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PriyomTx } from "@/lib/priyom-schedule";
import type { Mode } from "@/lib/radio-types";
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
    const { rerenderAt } = renderPanel("2026-11-25T07:10:00Z", { priyom });
    rerenderAt("2026-11-25T07:11:00Z", { picked: "e11", connecting: true });
    expect(status()).toBe("Connecting…");
    rerenderAt("2026-11-25T07:12:00Z", { picked: "e11", connecting: false, playing: true });
    expect(status()).toBe("Playing.");
    rerenderAt("2026-11-25T07:16:00Z", { picked: "e11", playing: true });
    expect(status()).toBe("E11 on the air now.");
    rerenderAt("2026-11-25T07:30:00Z", { picked: "e11", playing: true });
    expect(status()).toBe("E11 ended.");
  });
});
