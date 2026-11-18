// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Receiver } from "./kiwi-list";
import { NOISE_REFRESH_MS, useNoise } from "./use-noise";

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
const row = { medianDb: 50, count: 6, baselineDb: 60, baselineCount: 20 };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    const band = new URL(url).searchParams.get("band");
    return new Response(JSON.stringify({ band, hourUtc: 1, windowDays: 30, receivers: { "a.example:8073": row } }));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useNoise", () => {
  // Value: protects=the page asks once per band for the receivers that cover it (lowercased keys), not per dial move, and gets the levels back; fails_when=every retune refetches, keys keep their case, or the answer never reaches the page; why_new=issue #67; seam=fetch stubbed; no_claim=the service's answer
  it("fetches once per band, for the receivers covering it", async () => {
    const { result, rerender } = renderHook(({ khz }) => useNoise(RECEIVERS, khz), { initialProps: { khz: 7_050 } });
    await waitFor(() => expect(result.current?.band).toBe("ham-40m"));
    expect(result.current?.receivers["a.example:8073"]).toEqual(row);
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe("/noise");
    expect(url.searchParams.get("receivers")).toBe("a.example:8073,b.example:8073");
    rerender({ khz: 7_150 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ khz: 14_100 });
    await waitFor(() => expect(result.current?.band).toBe("ham-20m"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks nothing outside the dial's bands", () => {
    renderHook(() => useNoise(RECEIVERS, 10_000));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Value: protects=a service that's down or older (no /noise) leaves Pick best on SNR without errors; fails_when=a rejected fetch or a 404 throws or sets junk levels; why_new=issue #67; seam=fetch stubbed; no_claim=none
  it("stays empty when the service can't answer", async () => {
    fetchMock.mockImplementation(async () => new Response("nope", { status: 404 }));
    const { result } = renderHook(() => useNoise(RECEIVERS, 7_050));
    await act(async () => {});
    expect(result.current).toBeNull();
    fetchMock.mockImplementation(async () => {
      throw new TypeError("network");
    });
    const second = renderHook(() => useNoise(RECEIVERS, 14_100));
    await act(async () => {});
    expect(second.result.current).toBeNull();
  });

  it("fetches again every NOISE_REFRESH_MS while in one band", async () => {
    vi.useFakeTimers();
    renderHook(() => useNoise(RECEIVERS, 7_050));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(NOISE_REFRESH_MS));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
