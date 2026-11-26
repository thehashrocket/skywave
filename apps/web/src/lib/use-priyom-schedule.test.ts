// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PriyomTx } from "./priyom-schedule";
import { scheduleState, usePriyomCopy } from "./use-priyom-schedule";

// The signals.priyom query as react-query reports it; each test sets it.
const query = vi.hoisted(() => ({ current: { data: undefined as unknown, isError: false } }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => query.current }));
vi.mock("@/lib/trpc", () => ({ useTRPC: () => ({ signals: { priyom: { queryOptions: () => ({}) } } }) }));

describe("scheduleState", () => {
  // Value: protects=a station page (#103) tells "still loading" (undefined: say nothing yet) apart from "no schedule" (null: say unavailable, check Priyom), and a failed request counts as no schedule rather than loading forever; fails_when=loading maps to null (false "unavailable" on every cold load), or a failed request maps to undefined (page silent ~15 min during an outage); why_new=#103 Codex and final-review findings; the SignalLive test mocks the hook, so nothing else pins this mapping; seam=none (pure function); no_claim=react-query's own state transitions
  it("keeps loading, no schedule and a failed request apart", () => {
    const tx: PriyomTx[] = [{ station: "E11", startMs: 0, khz: 8_102, mode: "usb", summary: "E11" }];
    expect(scheduleState(undefined, false)).toBeUndefined();
    expect(scheduleState(undefined, true)).toBeNull();
    expect(scheduleState({ transmissions: null }, false)).toBeNull();
    expect(scheduleState({ transmissions: tx }, false)).toBe(tx);
    expect(scheduleState({ transmissions: tx }, true)).toBe(tx);
  });
});

describe("usePriyomCopy (#148)", () => {
  // Value: protects=the merged schedule's three Priyom states (D4): loading is undefined (Priyom stations show nothing, not EiBi's season grid), a failed first request or a server with no copy is null (EiBi rows marked unconfirmed), and a copy keeps its fetchedAt for the span check (D13); fails_when=loading maps to null (every cold load flashes E11's season rows as unconfirmed), a failed request stays undefined (Priyom stations blank for the 15-minute retry), or the copy loses fetchedAt; why_new=/ship coverage audit of #148: page.test mocks this hook and scheduleState covers only the panel's mapping; seam=useQuery and useTRPC mocked; no_claim=react-query's own state transitions
  it("keeps loading, none and a copy apart", () => {
    const state = (data: unknown, isError: boolean) => {
      query.current = { data, isError };
      return renderHook(() => usePriyomCopy()).result.current;
    };
    const copy = { transmissions: [{ station: "E11", startMs: 0, khz: 8_102, mode: "usb", summary: "E11" }], fetchedAt: 1_000 };
    expect(state(undefined, false)).toBeUndefined();
    expect(state(undefined, true)).toBeNull();
    expect(state(null, false)).toBeNull();
    expect(state(copy, false)).toBe(copy);
    expect(state(copy, true)).toBe(copy);
  });
});
