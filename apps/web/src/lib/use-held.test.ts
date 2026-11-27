// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Receiver } from "./kiwi-list";
import { NOISE_MAX_RECEIVERS } from "./noise-rank";
import { heldUrl, parseHeld, useHeld } from "./use-held";

const rx = (name: string): Receiver => ({
  id: name,
  name,
  location: "",
  antenna: "",
  host: `${name}.Example`,
  port: 8073,
  users: 0,
  usersMax: 8,
  snr: 20,
  minKhz: 0,
  maxKhz: 30_000,
});
const RECEIVERS = [rx("a"), rx("b")];

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ held: ["a.example:8073"] })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  // Unmount each test's hooks, so their intervals and visibility listeners don't answer the next test.
  cleanup();
  vi.unstubAllGlobals();
});

describe("useHeld", () => {
  // Value: protects=the page asks /held about the receivers it would pick from (lowercased keys, on the service the WebSocket points at) and gets the held ones back as a set; fails_when=the URL is built off the wrong host or path, keys keep their case, or the answer never reaches the page; why_new=#155: skywave_cap was the most common refusal and the page had no way to see it coming; seam=fetch stubbed; no_claim=the service's answer
  it("asks about the receivers it would pick from and returns the held ones", async () => {
    const { result } = renderHook(() => useHeld(RECEIVERS, 7_050));
    await waitFor(() => expect(result.current.has("a.example:8073")).toBe(true));
    expect(result.current.has("b.example:8073")).toBe(false);
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe("/held");
    expect(url.searchParams.get("receivers")).toBe("a.example:8073,b.example:8073");
  });

  // Value: protects=a service that can't answer (older build without /held, down) leaves nothing marked, so Pick best keeps its plain rank order; fails_when=an error body or non-JSON is read as a held list, or the hook throws; why_new=the web deploys before or without the radio service; seam=fetch stubbed; no_claim=none
  it("marks nothing when the service can't answer", async () => {
    fetchMock.mockImplementation(async () => new Response("not found", { status: 404 }));
    const { result } = renderHook(() => useHeld(RECEIVERS, 7_050));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });

  // Value: protects=once the receivers asked about change (the dial crossed a coverage edge, the list refreshed), the old answer stops counting until the new one arrives, so Pick best doesn't demote and the list doesn't mark receivers from a stale question; fails_when=the hook returns the last set whatever keys it answered; why_new=the existing tests ask once; seam=fetch stubbed; no_claim=none
  it("drops an answer about other receivers when the list changes", async () => {
    const { result, rerender } = renderHook(({ list }) => useHeld(list, 7_050), {
      initialProps: { list: RECEIVERS },
    });
    await waitFor(() => expect(result.current.has("a.example:8073")).toBe(true));
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    rerender({ list: [rx("a"), rx("c")] });
    expect(result.current.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Value: protects=a hidden tab doesn't poll /held, and asks as soon as it's shown again; fails_when=the visibility check or the visibilitychange listener is dropped; why_new=the existing tests run visible; seam=document.visibilityState stubbed, fetch stubbed; no_claim=the 60 s interval
  it("waits for the tab to be visible before asking", async () => {
    let state: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    try {
      const { result } = renderHook(() => useHeld(RECEIVERS, 7_050));
      expect(fetchMock).not.toHaveBeenCalled();
      state = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(result.current.has("a.example:8073")).toBe(true));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  // Value: protects=the page asks about exactly the receivers Pick best would try first (the top NOISE_MAX_RECEIVERS of rankReceivers at the dial itself), so the query stays under the service's 100 cap and a top candidate is never left unchecked, while a dial move that changes no coverage doesn't ask again; fails_when=the slice is dropped, ranking is skipped, keys are ranked at some other frequency (a bucket anchor missed receivers covering the dial), or every dial move refetches; why_new=Codex adversarial review: a bucket anchor left top candidates out of /held; seam=fetch stubbed; no_claim=none
  it("asks about the top-ranked receivers at the dial, and again only when coverage changes", async () => {
    const ranked = Array.from({ length: NOISE_MAX_RECEIVERS + 1 }, (_, i) => ({ ...rx(`r${i}`), snr: i + 1 }));
    // Covers 7,020 kHz and up, with the best SNR of all: in the list at 7,050, not at 7,010.
    const edge = { ...rx("edge"), snr: 999, minKhz: 7_020 };
    const { rerender } = renderHook(({ freq }) => useHeld([...ranked, edge], freq), {
      initialProps: { freq: 7_050 },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const asked = new URL(fetchMock.mock.calls[0]![0] as string).searchParams.get("receivers")!.split(",");
    expect(asked).toHaveLength(NOISE_MAX_RECEIVERS);
    expect(asked).toContain("edge.example:8073");
    expect(asked).not.toContain("r0.example:8073"); // with edge in, r0 (lowest SNR) is 102nd
    expect(asked).not.toContain("r1.example:8073"); // and r1 101st
    rerender({ freq: 7_200 }); // same receivers cover 7,200
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ freq: 7_010 }); // edge no longer covers the dial
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(new URL(fetchMock.mock.calls[1]![0] as string).searchParams.get("receivers")).not.toContain("edge.example");
  });

  // Value: protects=once a refresh fails (a 404 from a route not yet deployed, a 503, a network error), the earlier answer is forgotten, so Pick best and the table go back to plain rank order instead of steering by stale occupancy; fails_when=the hook keeps the last set after a failed refresh; why_new=native and both Codex reviews: a stale answer was kept forever; seam=fetch stubbed, refresh via visibilitychange (the same load the interval runs); no_claim=the 60 s interval itself
  it("forgets the answer when a refresh fails", async () => {
    // Each refresh is the same load() the HELD_REFRESH_MS interval runs, triggered by the tab being shown.
    const refresh = () => document.dispatchEvent(new Event("visibilitychange"));
    const { result } = renderHook(() => useHeld(RECEIVERS, 7_050));
    await waitFor(() => expect(result.current.has("a.example:8073")).toBe(true));
    fetchMock.mockImplementation(async () => new Response("not found", { status: 404 }));
    refresh();
    await waitFor(() => expect(result.current.size).toBe(0));
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ held: ["a.example:8073"] })));
    refresh();
    await waitFor(() => expect(result.current.has("a.example:8073")).toBe(true));
    fetchMock.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    refresh();
    await waitFor(() => expect(result.current.size).toBe(0));
  });

  // Value: protects=the page asks again when its own receiver changes or stops, so a receiver it just left (held by its own old slot) stops reading as taken within one answer, not up to a minute; fails_when=`playing` stops triggering a refetch; why_new=native adversarial review; seam=fetch stubbed; no_claim=the service releasing the slot (test_held.py)
  it("asks again when this page's receiver changes", async () => {
    const { rerender } = renderHook(({ mine }) => useHeld(RECEIVERS, 7_050, mine), {
      initialProps: { mine: "a.example:8073" as string | null },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ mine: null });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    rerender({ mine: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("heldUrl and parseHeld", () => {
  // Value: protects=wss:// maps to https:// and a path prefix before /ws is kept, and only string keys from a well-formed answer count; fails_when=the scheme or prefix is lost, or a malformed answer becomes a set; why_new=new endpoint client; seam=none; no_claim=none
  it("builds the URL from the WebSocket's and reads only a well-formed answer", () => {
    expect(heldUrl("wss://radio.example/api/ws", ["a:8073"])).toBe("https://radio.example/api/held?receivers=a%3A8073");
    expect(heldUrl("not a url", ["a:8073"])).toBeNull();
    expect([...parseHeld({ held: ["a:8073", 5] })!]).toEqual(["a:8073"]);
    expect(parseHeld({ held: "a:8073" })).toBeNull();
    expect(parseHeld(null)).toBeNull();
  });
});
