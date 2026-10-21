// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Receiver } from "@/lib/kiwi-list";
import { MapPanel, type MapList } from "./MapPanel";
import type { ReceiverMapProps } from "./ReceiverMap";

// The adapter needs WebGL; stand in for it and keep what it was given.
const adapter = vi.hoisted(() => ({ props: [] as ReceiverMapProps[], mounts: 0, throwing: false }));
vi.mock("./ReceiverMap", async () => {
  const { useEffect } = await import("react");
  return {
    default: function FakeReceiverMap(props: ReceiverMapProps) {
      if (adapter.throwing) throw new Error("Loading chunk failed");
      adapter.props.push(props);
      useEffect(() => {
        adapter.mounts++;
      }, []);
      return <div data-testid="adapter" />;
    },
  };
});

afterEach(() => {
  cleanup();
  adapter.props.length = 0;
  adapter.mounts = 0;
});

function rx(host: string, over: Partial<Receiver> = {}): Receiver {
  return {
    id: host,
    name: `${host} name`,
    location: "",
    antenna: "",
    host,
    port: 8073,
    users: 0,
    usersMax: 8,
    snr: 20,
    minKhz: 0,
    maxKhz: 30_000,
    lat: 1,
    lon: 2,
    ...over,
  };
}

const okList: MapList = { receivers: [rx("a.example")], ageMs: 4 * 60_000, failed: false, retry: vi.fn() };

function setup(over: Partial<Parameters<typeof MapPanel>[0]> = {}) {
  const props = {
    admitted: true,
    list: okList,
    freqKhz: 9_535,
    sun: { declination: 0, subsolarLon: 0, at: Date.parse("2026-10-21T03:12:30Z") },
    playing: null,
    last: null,
    onListen: vi.fn(),
    onBrowse: vi.fn(),
    ...over,
  };
  return { props, ...render(<MapPanel {...props} />) };
}

const lastProps = () => adapter.props.at(-1)!;

describe("MapPanel", () => {
  // Value: protects=before the radio starts, the panel holds its space and says when the map comes, without loading MapLibre; fails_when=the adapter mounts before admission or the shell is missing; why_new=O4, R7, design state table; seam=adapter mocked; no_claim=network requests (the adapter's import is the request)
  it("shows a reserved shell until admitted, then loads the adapter", async () => {
    const { rerender, props } = setup({ admitted: false });
    expect(screen.getByText("Map loads once the radio is playing")).toBeTruthy();
    expect(screen.queryByTestId("adapter")).toBeNull();
    rerender(<MapPanel {...props} admitted />);
    expect(await screen.findByTestId("adapter")).toBeTruthy();
    expect(screen.queryByText("Map loads once the radio is playing")).toBeNull();
  });

  // Value: protects=the heading follows the dial and the legend says when the greyline and list are from, warning when the list is old; fails_when=the heading is static, times are local not UTC, or a 40-minute-old list reads like a fresh one; why_new=design decision 10, state table (list age); seam=none; no_claim=styling of the warning
  it("labels the dial frequency, greyline time and list age", () => {
    const { rerender, props } = setup();
    expect(screen.getByRole("heading", { name: "Receiver map · 9,535 kHz" })).toBeTruthy();
    expect(screen.getByText("Greyline 03:12 UTC", { exact: false })).toBeTruthy();
    expect(screen.getByText("List 4 min old").hasAttribute("data-old")).toBe(false);
    rerender(<MapPanel {...props} list={{ ...okList, ageMs: 40 * 60_000 }} />);
    expect(screen.getByText("List 40 min old").hasAttribute("data-old")).toBe(true);
  });

  // Value: protects=a failed list says so over the map with a retry, while the adapter stays mounted to draw the greyline; fails_when=a list failure leaves an empty map with no explanation; why_new=R10; seam=list prop; no_claim=the query itself (picker tests)
  it("explains a missing list and retries it", async () => {
    const retry = vi.fn();
    setup({ list: { receivers: undefined, ageMs: undefined, failed: true, retry } });
    expect(screen.getByText("Receiver list unavailable.")).toBeTruthy();
    expect(await screen.findByTestId("adapter")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry receiver list" }));
    expect(retry).toHaveBeenCalled();
  });

  it("says when there's nothing to draw", async () => {
    setup({ list: { ...okList, receivers: [rx("x.example", { lat: undefined, lon: undefined })] } });
    expect(screen.getByText("No receivers to show")).toBeTruthy();
  });

  // Value: protects=a map that can't draw says why, offers Retry (a fresh map) and a way to the table; fails_when=failure is silent, Retry reuses the broken adapter, or Browse isn't offered; why_new=design state table, E4; seam=adapter mocked, onFail called by hand; no_claim=what makes MapLibre fail (adapter tests)
  it("offers Retry map and Browse receivers when the map fails", async () => {
    const { props } = setup();
    await screen.findByTestId("adapter");
    act(() => lastProps().onFail("map tiles aren't loading"));
    expect(screen.getByText("Map unavailable: map tiles aren't loading.")).toBeTruthy();
    expect(screen.queryByTestId("adapter")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Browse receivers" }));
    expect(props.onBrowse).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry map" }));
    await screen.findByTestId("adapter");
    expect(adapter.mounts).toBe(2);
  });

  // Value: protects=Center appears only with something playing, is disabled for a receiver with no position (with a chip saying so), and puts the camera back in follow mode; fails_when=Center shows with nothing playing, chases an unlocated receiver, or doesn't re-center after a pan; why_new=design D8 and the "no location" state; seam=adapter props; no_claim=the camera itself (adapter tests)
  it("centers on the receiver playing, or says it has no location", async () => {
    const { rerender, props } = setup();
    await screen.findByTestId("adapter");
    expect(screen.queryByRole("button", { name: "Center on receiver" })).toBeNull();

    rerender(<MapPanel {...props} playing={{ host: "a.example", port: 8073, phase: "listening" }} />);
    act(() => lastProps().onUserMove());
    expect(lastProps().follow).toBe("stay");
    fireEvent.click(screen.getByRole("button", { name: "Center on receiver" }));
    expect(lastProps()).toMatchObject({ follow: "follow", centerRequest: 1 });

    rerender(<MapPanel {...props} playing={{ host: "typed.example", port: 8073, phase: "listening" }} />);
    expect((screen.getByRole("button", { name: "Center on receiver" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Playing typed.example:8073 · no location")).toBeTruthy();
  });

  // Value: protects=the map's code failing to load (a redeploy, a dropped connection) shows "Map unavailable" with Retry instead of crashing the page and the radio with it; fails_when=there's no error boundary around the lazy adapter; why_new=red team CRITICAL (PR 2b ship); seam=the mocked adapter throws on render; no_claim=Next's chunk loading
  it("turns a map that fails to load into Map unavailable, and retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    adapter.throwing = true;
    setup();
    expect(await screen.findByText("Map unavailable: its code didn't load.")).toBeTruthy();
    adapter.throwing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry map" }));
    expect(await screen.findByTestId("adapter")).toBeTruthy();
    vi.mocked(console.error).mockRestore();
  });

  // Value: protects=Center is offered only when pressing it can move the map (listening, located, map up); fails_when=Center is enabled while connecting or before the map loads and looks like it does nothing; why_new=red team (PR 2b ship); seam=none; no_claim=the camera (adapter tests)
  it("enables Center only while listening with the map up", async () => {
    const connecting = { host: "a.example", port: 8073, phase: "connecting" as const };
    const { rerender, props } = setup({ admitted: false, playing: connecting });
    const center = () => screen.getByRole("button", { name: "Center on receiver" }) as HTMLButtonElement;
    expect(center().disabled).toBe(true);
    rerender(<MapPanel {...props} admitted playing={connecting} />);
    await screen.findByTestId("adapter");
    expect(center().disabled).toBe(true);
    rerender(<MapPanel {...props} admitted playing={{ ...connecting, phase: "listening" }} />);
    expect(center().disabled).toBe(false);
  });

  // Value: protects=the card's Listen reaches the page's switch path untouched; fails_when=MapPanel swallows or rewraps onListen; why_new=R1; seam=adapter props; no_claim=chooseReceiver (page tests)
  it("passes Listen straight through", async () => {
    const { props } = setup();
    await screen.findByTestId("adapter");
    lastProps().onListen(okList.receivers![0]!);
    expect(props.onListen).toHaveBeenCalledWith(okList.receivers![0]);
  });
});
