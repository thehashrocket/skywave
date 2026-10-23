import { describe, expect, it } from "vitest";
import { listFailed, nextRefetchMs } from "./use-receiver-list";

describe("nextRefetchMs", () => {
  // Value: protects=the list is polled just after the server's copy expires, then at the server's retry pace, and soon after a failed first load; fails_when=nextRefetchMs's age thresholds or the floor/ceiling drift; why_new=list polling (PR 1 review, skew-proof in PR 2a); seam=none; no_claim=react-query's timer itself
  it.each([
    ["a copy 10 min old", 10 * 60_000, 5 * 60_000 + 5_000],
    ["a copy fetched just now", 0, 15 * 60_000],
    ["a copy a moment from expiring", 15 * 60_000 - 1, 5_001],
    ["a copy that just expired (the server is refreshing it)", 15 * 60_000, 15_000],
    ["an expired copy within the server's retry window", 16 * 60_000 - 1, 15_000],
    ["a copy still old after the server's retry (mirror down)", 16 * 60_000, 60_000],
    ["a stale copy from a long outage", 60 * 60_000, 60_000],
    ["no copy yet (the first load failed)", undefined, 15_000],
  ])("polls again at the right time: %s", (_case, age, wait) => {
    expect(nextRefetchMs(age)).toBe(wait);
  });
});

describe("listFailed", () => {
  // Value: protects=a failed list stays "failed" through retries, while a first load still pending and a list kept after a failed refetch don't count (blank Listen's message and the picker's Try again both read it); fails_when=it keys on isError or on pending alone; why_new=moved out of ReceiverPicker for the page to share; seam=none; no_claim=react-query's own state transitions
  it.each([
    ["loading, never failed", { errorUpdatedAt: 0 }, false],
    ["failed with nothing to show", { errorUpdatedAt: 1 }, true],
    ["a list kept after a failed refetch", { data: { receivers: [] }, errorUpdatedAt: 1 }, false],
  ])("%s", (_case, list, failed) => {
    expect(listFailed(list)).toBe(failed);
  });
});
