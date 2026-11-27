"use client";

import { useQuery } from "@tanstack/react-query";
import type { OnAirRow } from "@/lib/on-air";
import { useTRPC } from "@/lib/trpc";

const HOUR = 60 * 60_000;

/**
 * The day/night stations' rows of the merged schedule (signals.dayNight, #168),
 * for a station page, which doesn't load the whole EiBi schedule: their switch
 * times, so the page names the channel the dial does. Asked only when `enabled`
 * (a day/night station's page). Undefined while the answer is on its way, so the
 * page holds its Listen rather than offer the sun's channel for a moment; null
 * when not asked, the request failed (after one retry) or it can't be sent
 * (offline), and the page then follows the sun as before.
 */
export function useDayNightRows(enabled: boolean): readonly OnAirRow[] | null | undefined {
  const trpc = useTRPC();
  const { data, isError, fetchStatus } = useQuery({
    ...trpc.signals.dayNight.queryOptions(),
    enabled,
    staleTime: 6 * HOUR,
    refetchOnWindowFocus: false,
    // The sun is a fair stand-in: don't hold the page through three retries.
    retry: 1,
  });
  return rowsState(enabled, data, isError || fetchStatus === "paused");
}

/** undefined while the rows are on their way; null when not asked or none can be had (failed or offline); else the rows. */
export function rowsState<T>(enabled: boolean, data: T | undefined, failed: boolean): T | null | undefined {
  if (!enabled) return null;
  if (data === undefined) return failed ? null : undefined;
  return data;
}
