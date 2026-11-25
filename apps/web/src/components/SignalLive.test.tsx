// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PriyomTx } from "@/lib/priyom-schedule";
import type { LastHeard } from "@/lib/signal-heard";

const state = {
  now: null as number | null,
  priyom: null as PriyomTx[] | null,
  heard: null as Record<string, LastHeard> | null,
};
vi.mock("@/lib/use-server-tick", () => ({ useServerTick: () => state.now }));
vi.mock("@/lib/use-priyom-schedule", () => ({ usePriyomSchedule: () => state.priyom }));
vi.mock("@/lib/use-signal-last-heard", () => ({ useSignalLastHeard: () => state.heard }));

const { SignalLive } = await import("./SignalLive");

const NOW = Date.parse("2026-11-25T07:00:00Z");
const tx = (station: string, iso: string, khz: number): PriyomTx => ({
  station,
  startMs: Date.parse(iso),
  khz,
  mode: "usb",
  summary: `${station} ${khz}kHz USB`,
});

afterEach(() => {
  cleanup();
  Object.assign(state, { now: null, priyom: null, heard: null });
});

describe("SignalLive", () => {
  // Value: protects=#103 a numbers station on the air now offers Listen to the main page tuned to Priyom's frequency for that transmission with the station named; fails_when=Listen points at no frequency, the wrong one, or drops sig=; why_new=#103 live line; seam=clock and queries mocked; no_claim=Priyom's data
  it("offers Listen on a numbers station's transmission now on", () => {
    Object.assign(state, { now: NOW, priyom: [tx("E11", "2026-11-25T06:55:00Z", 8_102)] });
    render(<SignalLive slug="e11" />);
    expect(screen.getByText(/On the air now on 8\.102 USB, 5 min left/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Listen" }).getAttribute("href")).toBe("/?f=8102&m=usb&sig=e11");
  });

  // Value: protects=a numbers station not on now says when it's next on, in UTC with the visitor's own time beside it, and with no schedule from the server says so and links Priyom, never offering Listen into silence; fails_when=a Listen appears before a transmission, or a missing schedule reads as "nothing this week"; why_new=#103 live line; seam=clock and queries mocked; no_claim=local time formatting per zone
  it("says when a numbers station is next on, or that the schedule is missing", () => {
    Object.assign(state, { now: NOW, priyom: [tx("E11", "2026-11-25T09:00:00Z", 8_102)] });
    const { unmount } = render(<SignalLive slug="e11" />);
    expect(screen.getByText(/Next on Wed 0900 UTC \(.+\) on 8\.102 USB, in 2h 0m\./)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Listen" })).toBeNull();
    unmount();
    Object.assign(state, { priyom: null });
    render(<SignalLive slug="e11" />);
    expect(screen.getByText(/Schedule unavailable right now/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "check Priyom" })).toBeTruthy();
  });

  // Value: protects=#103 a numbers station with a schedule but no slot this week says nothing is listed and links Priyom, without Listen and without claiming the schedule is unavailable; fails_when=an empty schedule reads as "unavailable", shows a Next line with no time, or offers Listen; why_new=the existing test covers a missing schedule (null) but not an empty one ([]); seam=clock and queries mocked; no_claim=Priyom's data
  it("says nothing is listed when the schedule has no slot for the station", () => {
    Object.assign(state, { now: NOW, priyom: [tx("S06", "2026-11-25T09:00:00Z", 5_000)] });
    render(<SignalLive slug="e11" />);
    expect(screen.getByText(/Nothing listed in the coming week/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "check Priyom" })).toBeTruthy();
    expect(screen.queryByText(/Schedule unavailable/)).toBeNull();
    expect(screen.queryByText(/Next on/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Listen" })).toBeNull();
  });

  // Value: protects=an always-on station offers Listen on its main channel, and listeners' last heard shows (shared WWV/WWVH wording kept); fails_when=an always-on station shows no Listen or the heard line is lost; why_new=#103 live line with #102 badge; seam=clock and queries mocked; no_claim=none
  it("offers Listen on an always-on station and shows when it was last heard", () => {
    Object.assign(state, {
      now: NOW,
      heard: { wwv: { heardMs: NOW - 40 * 60_000, either: ["WWV", "WWVH"], heard24h: 0, notHeard24h: 0 } },
    });
    render(<SignalLive slug="wwv" />);
    expect(screen.getByRole("link", { name: "Listen" }).getAttribute("href")).toBe("/?f=10000&m=am&sig=wwv");
    expect(screen.getByText("Listeners: WWV or WWVH heard 40 min ago.")).toBeTruthy();
  });

  // Value: protects=before the page knows the server's time nothing time-dependent shows (the static HTML never claims "on now"), and a defunct station shows nothing at all; fails_when=a stale status renders from the build or a defunct station gets a Listen; why_new=#103 live line; seam=clock mocked; no_claim=none
  it("shows nothing before the clock is known, or for a defunct station", () => {
    const { container, unmount } = render(<SignalLive slug="uvb-76" />);
    expect(container.textContent).toBe("");
    unmount();
    Object.assign(state, { now: NOW });
    const { container: gone } = render(<SignalLive slug="cherry-ripe" />);
    expect(gone.innerHTML).toBe("");
  });

  // Value: protects=a numbers station on the air with no frequency listed yet (Priyom's "Search" slot) reads as on now, as the panel shows it, with no Listen (nothing to tune); fails_when=the page shows the next slot or "nothing listed" while the panel says on now, or offers Listen with no frequency; why_new=#103 Step 7 coverage audit found the mismatch; seam=clock and queries mocked; no_claim=Priyom's data
  it("says a numbers station is on the air before its frequency is listed", () => {
    const search: PriyomTx = { station: "M12", startMs: NOW - 2 * 60_000, khz: null, mode: null, summary: "M12 Search" };
    Object.assign(state, { now: NOW, priyom: [search] });
    render(<SignalLive slug="m12" />);
    expect(screen.getByText(/On the air now; Priyom hasn.t listed the frequency yet\./)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Listen" })).toBeNull();
  });
});
