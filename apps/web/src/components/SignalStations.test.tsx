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
  render(
    <SignalStations
      freqKhz={props.freqKhz ?? 9420}
      mode={props.mode ?? "am"}
      priyom={props.priyom ?? null}
      picked={props.picked ?? null}
      connecting={props.connecting ?? false}
      playing={props.playing ?? false}
      onListen={onListen}
    />,
  );
  return { onListen };
}

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
});
