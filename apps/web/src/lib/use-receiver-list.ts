"use client";

import { useQuery } from "@tanstack/react-query";
import { LIST_MAX_AGE_MS, LIST_RETRY_MS } from "@/lib/kiwi-list";
import { useTRPC } from "@/lib/trpc";

// Slack after the server's copy expires, so the poll finds the new one.
const EXPIRY_SLACK_MS = 5_000;
// Just after expiry the server is fetching a new copy; ask again soon.
const JUST_EXPIRED_POLL_MS = 15_000;

/**
 * When to poll the list again, given how old the server's copy is now: just
 * after it expires. For one retry window after that, ask again soon; later,
 * the mirror is down, so follow the server's own retry pace. Never longer
 * than one cache lifetime. With no list yet (the first load failed), ask
 * again soon: the server only waits a few seconds before retrying the mirror.
 */
export function nextRefetchMs(age: number | undefined): number {
  if (age === undefined) return JUST_EXPIRED_POLL_MS;
  if (age >= LIST_MAX_AGE_MS + LIST_RETRY_MS) return LIST_RETRY_MS;
  if (age >= LIST_MAX_AGE_MS) return JUST_EXPIRED_POLL_MS;
  return Math.min(LIST_MAX_AGE_MS, LIST_MAX_AGE_MS - age + EXPIRY_SLACK_MS);
}

/**
 * How old a copy of the list is now: the server's age for it when it answered,
 * plus the time since by this browser's clock. The two clocks are never compared.
 */
export function ageNow(serverAgeMs: number, receivedAt: number): number {
  return serverAgeMs + (Date.now() - receivedAt);
}

/** What the page and the Receivers section say when the list couldn't load. */
export const LIST_FAILED_TEXT = "Couldn't load the public receiver list.";

/**
 * Whether the list failed with nothing to show. Refetching a query with no
 * data puts it back to pending, so "loading" means no failure yet: after one,
 * the failure stays through every retry and poll.
 */
export function listFailed(list: { data?: unknown; errorUpdatedAt: number }): boolean {
  return !list.data && list.errorUpdatedAt > 0;
}

/**
 * The public receiver list. One definition, so the page and the Receivers
 * section share a fetch, a cache and the same refresh rules.
 */
export function useReceiverList() {
  const trpc = useTRPC();
  // The list changes slowly and the server caches it for 15 minutes, so
  // don't refetch on every focus.
  return useQuery({
    ...trpc.receivers.list.queryOptions(),
    staleTime: 5 * 60_000,
    // Just after the server's copy expires, while the tab is visible, so
    // listener counts and full receivers stay current.
    refetchInterval: (query) => {
      const data = query.state.data;
      return nextRefetchMs(data && ageNow(data.ageMs ?? 0, query.state.dataUpdatedAt));
    },
    // The poll above is the retry policy; extra retries would only repeat the server's cached failure.
    retry: false,
  });
}
