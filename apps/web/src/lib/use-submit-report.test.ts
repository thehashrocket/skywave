// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn();
vi.mock("@tanstack/react-query", () => ({ useMutation: () => ({ mutate }) }));
vi.mock("./trpc", () => ({
  useTRPC: () => ({ reports: { submit: { mutationOptions: () => ({}) }, submitGroup: { mutationOptions: () => ({}) } } }),
}));
vi.mock("@vercel/analytics", () => ({ track: vi.fn() }));
vi.mock("./listener-id", () => ({ listenerId: () => "listener-1" }));

import { track } from "@vercel/analytics";
import type { PickContext } from "./pick-context";
import { useSubmitGroupReport, useSubmitReport } from "./use-submit-report";
import type { ReceptionPromptData } from "./use-reception-prompt";

const prompt: ReceptionPromptData = {
  host: "kiwi.example.org",
  port: 8073,
  freqKhz: 9_580,
  mode: "am",
  tx: { kind: "eibi", name: "KBS World Radio", label: "KBS World Radio" },
};

const pick: PickContext = {
  version: 2,
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

  // Value: protects=the question's rule and region reach reports.submit as askRule and askRegion, and a question without them sends neither; fails_when=the hook drops or renames them, so #61 can't tell question rules apart; why_new=#115 review D1/D2; seam=useMutation, useTRPC, listenerId mocked; no_claim=server storage (reports.test)
  it("sends the question's rule and region", () => {
    const { result } = renderHook(() => useSubmitReport());
    result.current({ ...prompt, tx: { ...prompt.tx, askRule: 1, askRegion: "na" } }, "heard", "");
    expect(mutate).toHaveBeenLastCalledWith(expect.objectContaining({ askRule: 1, askRegion: "na" }));
    result.current(prompt, "heard", "");
    expect(mutate.mock.lastCall![0]).toMatchObject({ askRule: undefined, askRegion: undefined });
  });
});

describe("useSubmitGroupReport (#150)", () => {
  beforeEach(() => mutate.mockClear());
  const group: ReceptionPromptData = {
    ...prompt,
    freqKhz: 10_000,
    tx: {
      kind: "signal",
      name: "wwv / wwvh",
      label: "WWV or WWVH",
      group: [
        { slug: "wwv", name: "WWV", hint: "a man's voice" },
        { slug: "x", name: "X", slotStartMs: 5 },
      ],
    },
  };

  // Value: protects=a shared-frequency answer sends the stations asked about (slug and Priyom slot only, no hints) with the choice, comment and pick for the server to map, and "can't tell" sends nothing and says so; fails_when=can't tell reaches the server, a slot is dropped (the server refuses a numbers station without it), or the page maps outcomes itself; why_new=#150 acceptance (can't-tell files no signal report); seam=useMutation, useTRPC, listenerId mocked; no_claim=tRPC serialisation
  it("sends the stations and the choice, and nothing for can't tell", () => {
    const { result } = renderHook(() => useSubmitGroupReport());
    expect(result.current(group, { heard: "wwv" }, "S9", pick)).toBe(true);
    expect(mutate).toHaveBeenLastCalledWith({
      listenerId: "listener-1",
      receiverHost: "kiwi.example.org",
      receiverPort: 8073,
      freqKhz: 10_000,
      mode: "am",
      stations: [{ slug: "wwv" }, { slug: "x", slotStartMs: 5 }],
      answer: { heard: "wwv" },
      comment: "S9",
      pick,
    });
    mutate.mockClear();
    expect(result.current(group, "unsure", "")).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });

  // Value: protects=analytics counts a shared-frequency answer only for a group question (can't tell included, as an answer given), and a prompt with no group records and sends nothing; fails_when=the event is tracked before the group check, so a stray call inflates reception_report counts; why_new=#150 review; seam=track, useMutation, useTRPC mocked; no_claim=Vercel Analytics delivery
  it("tracks an answer only for a group question", () => {
    vi.mocked(track).mockClear();
    const { result } = renderHook(() => useSubmitGroupReport());
    expect(result.current(prompt, "all", "")).toBe(false);
    expect(track).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    result.current(group, "unsure", "");
    expect(track).toHaveBeenLastCalledWith("reception_report", { outcome: "unsure", group: true });
  });
});
