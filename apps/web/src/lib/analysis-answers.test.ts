import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NOT_HEARD_OVER_OTHER } from "./signal-heard";

// The real module opens a Prisma client at import; only the SQL is run here.
vi.mock("@/server/db", () => ({ db: {} }));
const { groupedTalliesSql } = await import("@/server/grouped-tallies");

const read = (url: URL) => readFileSync(url, "utf8");
/** The #148 filter and #169's answer CTEs, as #61's queries paste them. */
const WITH = `WITH ${read(new URL("../../analysis/61-exclude-priyom-eibi.sql", import.meta.url))}, ${read(
  new URL("../../analysis/61-answers.sql", import.meta.url),
)}`;

describe("61-answers.sql (#169)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE "ReceptionReport" (id text, "createdAt" timestamp(3), "listenerId" text, "txKind" text,
      "txName" text, outcome text, comment text, "pickSource" text, "askRule" int, "askGroup" text)`);
    // g1 "Heard WWV" with Pick best context, g2 "Heard both", g3 "Heard nothing",
    // g4 "Didn't open", a single-station answer, an ungrouped heard (so a NULL
    // partition would wrongly relabel the single-station not_heard), and an old EiBi answer the #148 filter drops.
    await db.exec(`INSERT INTO "ReceptionReport" VALUES
      ('a1', '2026-11-27 07:00', 'l1', 'signal', 'wwv', 'heard', 'clear', 'listen', NULL, 'g1'),
      ('a2', '2026-11-27 07:00', 'l1', 'signal', 'wwvh', 'not_heard', 'clear', 'listen', NULL, 'g1'),
      ('b1', '2026-11-27 08:00', 'l2', 'signal', 'wwvh', 'heard', NULL, NULL, NULL, 'g2'),
      ('b2', '2026-11-27 08:00', 'l2', 'signal', 'wwv', 'heard', NULL, NULL, NULL, 'g2'),
      ('c1', '2026-11-27 09:00', 'l3', 'signal', 'wwv', 'not_heard', NULL, NULL, NULL, 'g3'),
      ('c2', '2026-11-27 09:00', 'l3', 'signal', 'wwvh', 'not_heard', NULL, NULL, NULL, 'g3'),
      ('d1', '2026-11-27 10:00', 'l4', 'signal', 'wwv', 'no_open', NULL, NULL, NULL, 'g4'),
      ('d2', '2026-11-27 10:00', 'l4', 'signal', 'wwvh', 'no_open', NULL, NULL, NULL, 'g4'),
      ('e1', '2026-11-27 11:00', 'l5', 'signal', 'chu', 'not_heard', NULL, 'signal', NULL, NULL),
      ('e2', '2026-11-27 11:30', 'l5', 'beacon', 'K6WX', 'heard', NULL, 'beacon', NULL, NULL),
      ('f1', '2026-11-27 12:00', 'l6', 'eibi', 'E11 Polish Spy Numbers', 'heard', NULL, NULL, 1, NULL)`);
  });
  afterAll(async () => {
    await db.close();
  });

  // Value: protects=run in Postgres (PGlite), analysed_answers gives one row per answer: a group counts once with its pick context once, "Didn't open" once (not doubling receiver failures), its stations " / "-joined, its outcome heard if any station was heard, no_open if it didn't open, else not_heard, and heard_names the stations heard; ungrouped rows pass through unchanged, after the #148 filter; fails_when=the DISTINCT ON or the GROUP BY drifts so a group counts twice, the outcome rule changes, or the row is rebuilt without its other columns; why_new=#169 acceptance ("Heard WWV" with Pick best context is one answer and one pick); seam=PGlite for Postgres; no_claim=the production table's other columns survive the jsonb rebuild (only those in this fixture are checked)
  it("counts each answer once, with the stations it named", async () => {
    const { rows } = await db.query(
      `${WITH} SELECT id, "txName", outcome, heard_names, comment, "pickSource", "listenerId" FROM analysed_answers ORDER BY "createdAt"`,
    );
    expect(rows).toEqual([
      { id: "a1", txName: "wwv / wwvh", outcome: "heard", heard_names: "wwv", comment: "clear", pickSource: "listen", listenerId: "l1" },
      { id: "b2", txName: "wwv / wwvh", outcome: "heard", heard_names: "wwv / wwvh", comment: null, pickSource: null, listenerId: "l2" },
      { id: "c1", txName: "wwv / wwvh", outcome: "not_heard", heard_names: null, comment: null, pickSource: null, listenerId: "l3" },
      { id: "d1", txName: "wwv / wwvh", outcome: "no_open", heard_names: null, comment: null, pickSource: null, listenerId: "l4" },
      { id: "e1", txName: "chu", outcome: "not_heard", heard_names: null, comment: null, pickSource: "signal", listenerId: "l5" },
      { id: "e2", txName: "K6WX", outcome: "heard", heard_names: null, comment: null, pickSource: "beacon", listenerId: "l5" },
    ]);
    const totals = await db.query(
      `${WITH} SELECT count(*)::int AS answers, (count(*) FILTER (WHERE "pickSource" IS NOT NULL))::int AS picked,
        (count(*) FILTER (WHERE outcome = 'no_open'))::int AS no_open FROM analysed_answers`,
    );
    expect(totals.rows).toEqual([{ answers: 6, picked: 3, no_open: 1 }]);
  });

  // Value: protects=run in Postgres (PGlite), analysed_station_reports keeps one row per station and relabels only a not_heard whose group has a heard as not heard over the other: WWVH beside "Heard WWV" is not_heard_over_other, "Heard nothing" stays not_heard, "Didn't open" stays no_open, an ungrouped not_heard stays not_heard; fails_when=the window partition or the CASE drifts (an ungrouped not_heard relabelled through a NULL partition, or "Heard nothing" read as over the other), so #61 reads a drowned-out WWVH as off the air (owner, #150); why_new=#169 acceptance; seam=PGlite for Postgres; no_claim=none
  it("marks a station not heard over the other only beside a heard", async () => {
    const { rows } = await db.query(`${WITH} SELECT id, outcome FROM analysed_station_reports ORDER BY id`);
    expect(rows).toEqual([
      { id: "a1", outcome: "heard" },
      { id: "a2", outcome: NOT_HEARD_OVER_OTHER },
      { id: "b1", outcome: "heard" },
      { id: "b2", outcome: "heard" },
      { id: "c1", outcome: "not_heard" },
      { id: "c2", outcome: "not_heard" },
      { id: "d1", outcome: "no_open" },
      { id: "d2", outcome: "no_open" },
      { id: "e1", outcome: "not_heard" },
      { id: "e2", outcome: "heard" },
    ]);
  });

  // Value: protects=the analysis view and the app's weekly tallies (groupedTalliesSql, #150) apply one rule, so #61 and the app can't disagree on what "not heard over the other" is, the label's spelling included; fails_when=either SQL's rule or label changes without the other; why_new=#169 shape ("the same rule as groupedTalliesSql"); seam=PGlite for Postgres; no_claim=the two read the same rows (the app's read has no #148 filter; signal rows never meet it)
  it("agrees with the app's grouped tallies", async () => {
    const app = await db.query(`${groupedTalliesSql(false)} ORDER BY 1, 2`, ["2026-11-01", "2026-11-30"]);
    const view = await db.query(
      `${WITH} SELECT "txName", outcome, COUNT(*)::int AS n FROM analysed_station_reports
        WHERE "txKind" = 'signal' AND "askGroup" IS NOT NULL AND outcome <> 'no_open' GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    expect(view.rows).toEqual(app.rows);
  });
});
