"use client";

import { useQuery } from "@tanstack/react-query";
import type { LastHeard } from "@/lib/signal-heard";
import { useTRPC } from "@/lib/trpc";

const MINUTE = 60_000;

/**
 * When listeners last heard each signal station (signals.lastHeard, #102),
 * by slug, for the panel's badges. The server reads the reports at most once
 * a minute, so the page asks every two; null until the first answer, or when
 * the server can't read them (the panel then shows no badges).
 */
export function useSignalLastHeard(): Record<string, LastHeard> | null {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.signals.lastHeard.queryOptions(),
    staleTime: 2 * MINUTE,
    refetchInterval: 2 * MINUTE,
  });
  return data?.heard ?? null;
}
