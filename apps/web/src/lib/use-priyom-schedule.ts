"use client";

import { useQuery } from "@tanstack/react-query";
import type { PriyomCopy } from "@/lib/on-air";
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
  return usePriyomScheduleState() ?? null;
}

/**
 * The same schedule, but undefined while the first answer is still on its way,
 * so a station page (#103) doesn't call the schedule unavailable during the
 * load; null still means the server has none.
 */
export function usePriyomScheduleState(): readonly PriyomTx[] | null | undefined {
  const { data, isError } = usePriyomQuery();
  return scheduleState(data, isError);
}

/**
 * The copy with when the server fetched it, for the merged schedule (#148,
 * on-air.ts), which needs the span it covers: undefined while the first answer
 * is on its way (D4: nothing shown), null when there's none or the request
 * failed. Shares the one query with the hooks above.
 */
export function usePriyomCopy(): PriyomCopy {
  const { data, isError } = usePriyomQuery();
  if (data === undefined) return isError ? null : undefined;
  return data;
}

function usePriyomQuery() {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.signals.priyom.queryOptions(),
    staleTime: HOUR,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data ? HOUR : 15 * MINUTE),
  });
}

/**
 * undefined while the first answer is on its way; null when the server has no
 * schedule or the request failed (so a page can say it's unavailable); else the
 * transmissions.
 */
export function scheduleState(
  data: { transmissions: readonly PriyomTx[] | null } | null | undefined,
  failed: boolean,
): readonly PriyomTx[] | null | undefined {
  if (data === undefined) return failed ? null : undefined;
  return data?.transmissions ?? null;
}
