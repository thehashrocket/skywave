import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { NOT_HEARD_OVER_OTHER } from "@/lib/signal-heard";

// The real module opens a Prisma client at import; only the SQL is run here.
vi.mock("@/server/db", () => ({ db: {} }));
const { groupedTalliesSql } = await import("./grouped-tallies");

describe("groupedTalliesSql (#150)", () => {
  // Value: protects=run in Postgres (PGlite), the database marks a not_heard beside a heard in the same askGroup as not heard over the other and keeps "Heard nothing" groups as plain not_heard, sums per station and outcome (and listener when asked), and leaves out ungrouped rows, other kinds, no_open and rows outside the window; fails_when=the window partition, the CASE or the filters drift, so WWVH drowned out by WWV counts toward the weekly "possibly off the air" (owner, #150), or ungrouped answers are counted twice; why_new=#150 review (sum in the database, not in the function); seam=PGlite for Postgres; no_claim=Prisma's parameter binding
  it("sums grouped answers, marking not heard over the other", async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE "ReceptionReport" ("txKind" text, "txName" text, outcome text, "listenerId" text, "askGroup" text, "createdAt" timestamp(3))`);
      await db.exec(`INSERT INTO "ReceptionReport" VALUES
        ('signal', 'wwv', 'heard', 'a', 'g1', '2026-11-20'),
        ('signal', 'wwvh', 'not_heard', 'a', 'g1', '2026-11-20'),
        ('signal', 'wwv', 'heard', 'b', 'g2', '2026-11-20'),
        ('signal', 'wwvh', 'not_heard', 'b', 'g2', '2026-11-20'),
        ('signal', 'wwv', 'not_heard', 'a', 'g3', '2026-11-21'),
        ('signal', 'wwvh', 'not_heard', 'a', 'g3', '2026-11-21'),
        ('signal', 'wwv', 'no_open', 'c', 'g4', '2026-11-21'),
        ('signal', 'wwvh', 'no_open', 'c', 'g4', '2026-11-21'),
        ('signal', 'wwvh', 'not_heard', 'd', NULL, '2026-11-21'),
        ('eibi', 'wwvh', 'not_heard', 'd', 'g5', '2026-11-21'),
        ('signal', 'wwv', 'heard', 'e', 'g6', '2026-09-01'),
        ('signal', 'wwvh', 'not_heard', 'e', 'g6', '2026-09-01')`);
      const run = async (byListener: boolean) =>
        (await db.query(`${groupedTalliesSql(byListener)} ORDER BY 1, 2, 3`, ["2026-11-01", "2026-11-30"])).rows;
      expect(await run(false)).toEqual([
        { txName: "wwv", outcome: "heard", n: 2 },
        { txName: "wwv", outcome: "not_heard", n: 1 },
        { txName: "wwvh", outcome: "not_heard", n: 1 },
        { txName: "wwvh", outcome: NOT_HEARD_OVER_OTHER, n: 2 },
      ]);
      expect(await run(true)).toContainEqual({ txName: "wwvh", outcome: NOT_HEARD_OVER_OTHER, listenerId: "b", n: 1 });
      expect(await run(true)).toHaveLength(6);
    } finally {
      await db.close();
    }
  });
});
