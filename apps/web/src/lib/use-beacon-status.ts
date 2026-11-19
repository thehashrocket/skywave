"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { offBeacons } from "@/lib/ibp-status";
import { quietBeacons } from "@/lib/rbn";
import { useTRPC } from "@/lib/trpc";

const HOUR = 60 * 60_000;

/**
 * The beacons NCDXF lists as off the air (issue #69), callsign to its note,
 * while beacon mode is on. The server refreshes the list every few hours, so
 * the page asks hourly; while the server has none yet (null), every beacon
 * counts as on the air and it asks again sooner.
 */
export function useBeaconStatus(enabled: boolean): ReadonlyMap<string, string | null> {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.beacons.status.queryOptions(),
    enabled,
    staleTime: HOUR,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data ? HOUR : HOUR / 4),
  });
  return useMemo(() => offBeacons(data), [data]);
}

/** The beacons RBN's skimmers didn't spot all day on `day` (issue #69 v2); `day` null with none known. */
export type RbnQuiet = { day: string | null; quiet: ReadonlySet<string> };

/**
 * RBN's quiet beacons for the last day the server has counted, while beacon
 * mode is on. The day changes once, after 01:00 UTC; the page asks hourly.
 */
export function useRbnQuiet(enabled: boolean): RbnQuiet {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.beacons.rbn.queryOptions(),
    enabled,
    staleTime: HOUR,
    refetchOnWindowFocus: false,
    refetchInterval: HOUR,
  });
  return useMemo(() => ({ day: data?.day ?? null, quiet: quietBeacons(data) }), [data]);
}
