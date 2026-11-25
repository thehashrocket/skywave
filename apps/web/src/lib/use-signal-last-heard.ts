"use client";

import { useQuery } from "@tanstack/react-query";
import type { LastHeard } from "@/lib/signal-heard";
import { useTRPC } from "@/lib/trpc";

const MINUTE = 60_000;

/**
 * When listeners last heard each signal station (signals.lastHeard, #102),
 * by slug, for the panel's badges. The server reads the reports at most once
 * every ten minutes (LAST_HEARD_TTL_MS, so the database can sleep between
 * reads), and the page asks as often; hidden tabs don't ask. Null until the
 * first answer, or when the server can't read them (the panel then shows no badges).
 */
export function useSignalLastHeard(): Record<string, LastHeard> | null {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.signals.lastHeard.queryOptions(),
    staleTime: 10 * MINUTE,
    refetchInterval: 10 * MINUTE,
    // The badges are optional and the server backs off after a failed read, so no
    // extra asks: no retries, and no refetch when the tab regains focus (#102 review).
    retry: false,
    refetchOnWindowFocus: false,
  });
  return data?.heard ?? null;
}
