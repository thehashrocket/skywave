"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";

const HOUR = 60 * 60_000;

/** How soon to ask again: every few hours, or soon while the server only has its bundled copy. */
export function scheduleRefetchMs(data: { bundled: boolean } | undefined): number {
  return data?.bundled ? HOUR / 4 : 6 * HOUR;
}

/**
 * The season's EiBi schedule, for naming stations. The server refreshes it
 * once a day, so the page asks every few hours; while the server only has
 * the bundled copy, it asks again sooner.
 */
export function useSchedule() {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.stations.schedule.queryOptions(),
    staleTime: 6 * HOUR,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => scheduleRefetchMs(query.state.data),
  });
}
