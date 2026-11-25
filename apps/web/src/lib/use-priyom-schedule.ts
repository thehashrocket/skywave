"use client";

import { useQuery } from "@tanstack/react-query";
import type { PriyomTx } from "@/lib/priyom-schedule";
import { useTRPC } from "@/lib/trpc";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Priyom's numbers-station schedule for the coming week (signals.priyom), for
 * the Signal stations panel. The server refreshes it every few hours, so the
 * page asks hourly; while the server has none yet (null: unreachable or not
 * fetched), the numbers stations are listed without times and it asks again
 * after the server's retry wait.
 */
export function usePriyomSchedule(): readonly PriyomTx[] | null {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.signals.priyom.queryOptions(),
    staleTime: HOUR,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data ? HOUR : 15 * MINUTE),
  });
  return data?.transmissions ?? null;
}
