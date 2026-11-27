import { NOT_HEARD_OVER_OTHER } from "@/lib/signal-heard";
import type { db as Db } from "./db";

/**
 * Shared-frequency answers (#150) summed by the database, so a read returns a
 * few rows per station however many answers there are (#102 review; a flood
 * of group answers mustn't grow what a read pulls in). In a group where some
 * station was heard ("Heard WWV"), the others' not_heard rows are counted as
 * NOT_HEARD_OVER_OTHER (owner, #150): WWVH drowned out by WWV says nothing
 * about WWVH being off the air. "Heard nothing" stays a plain not_heard.
 * Rows with no askGroup are left to the callers' own sums.
 *
 * `byListener` adds the listener to the grouping, as #147's suspect check
 * needs. The SQL is built from these fixed fragments only; the window comes
 * in as parameters ($1, $2).
 */
export function groupedTalliesSql(byListener: boolean): string {
  const listener = byListener ? `, "listenerId"` : "";
  return `SELECT "txName", outcome${listener}, COUNT(*)::int AS n FROM (
  SELECT "txName", "listenerId",
    CASE WHEN outcome = 'not_heard' AND bool_or(outcome = 'heard') OVER (PARTITION BY "askGroup")
      THEN '${NOT_HEARD_OVER_OTHER}' ELSE outcome END AS outcome
  FROM "ReceptionReport"
  WHERE "txKind" = 'signal' AND "askGroup" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" <= $2
) g
WHERE outcome IN ('heard', 'not_heard', '${NOT_HEARD_OVER_OTHER}')
GROUP BY "txName", outcome${listener}`;
}

export type GroupedTally = { txName: string; outcome: string; listenerId?: string; n: number };

/** groupedTalliesSql's rows for answers created from `from` to `to`, inclusive. */
export async function groupedTallies(db: typeof Db, from: Date, to: Date, byListener: boolean): Promise<GroupedTally[]> {
  return db.$queryRawUnsafe<GroupedTally[]>(groupedTalliesSql(byListener), from, to);
}
