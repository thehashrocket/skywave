// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn();
vi.mock("@tanstack/react-query", () => ({ useMutation: () => ({ mutate }) }));
vi.mock("./trpc", () => ({ useTRPC: () => ({ reports: { submit: { mutationOptions: () => ({}) } } }) }));
vi.mock("@vercel/analytics", () => ({ track: vi.fn() }));
vi.mock("./listener-id", () => ({ listenerId: () => "listener-1" }));

import type { PickContext } from "./pick-context";
import { useSubmitReport } from "./use-submit-report";
import type { ReceptionPromptData } from "./use-reception-prompt";

const prompt: ReceptionPromptData = {
  host: "kiwi.example.org",
  port: 8073,
  freqKhz: 9_580,
  mode: "am",
  tx: { kind: "eibi", name: "KBS World Radio", label: "KBS World Radio" },
};

const pick: PickContext = {
  pickedAtMs: 1_000,
  pickSource: "drawer",
  rankPos: 0,
  candidates: ["kiwi.example.org:8073"],
  freqKhz: 9_580,
  snr: null,
  users: 2,
};

describe("useSubmitReport", () => {
  beforeEach(() => mutate.mockClear());

  // Value: protects=Pick best's context reaches reports.submit unchanged, and an answer without one sends no pick; fails_when=the hook drops, renames or rebuilds pick, or invents one when absent; why_new=pick param (#61) had no hook test; seam=useMutation, useTRPC, listenerId mocked; no_claim=tRPC serialisation
  it("passes Pick best's context through to the mutation, and none when absent", () => {
    const { result } = renderHook(() => useSubmitReport());
    result.current(prompt, "heard", "S7", pick);
    expect(mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ receiverHost: "kiwi.example.org", outcome: "heard", comment: "S7", pick }),
    );
    expect(mutate.mock.lastCall![0].pick).toBe(pick);

    result.current(prompt, "not_heard", "");
    expect(mutate.mock.lastCall![0].pick).toBeUndefined();
  });
});
