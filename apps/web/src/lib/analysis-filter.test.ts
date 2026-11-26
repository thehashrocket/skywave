import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { SIGNAL_STATIONS } from "./signal-stations";

/** The committed #61 filter (#148 D9), a CTE named analysed_reports. */
const CTE = readFileSync(new URL("../../analysis/61-exclude-priyom-eibi.sql", import.meta.url), "utf8");

/** The names the filter lists, from its IN (...) list (the comments' apostrophes left alone). */
const listed = (sql: string) => [...(/\bIN \(([^)]*)\)/.exec(sql)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]!);

describe("61-exclude-priyom-eibi.sql", () => {
  // Value: protects=the filter's names contain every EiBi name of a catalog station Priyom drives, so a station added to the catalog can't leave its old EiBi answers in #61's data; contains-all, not equal, because names are only ever added: past answers carry old seasons' names, and removing one would quietly bring those answers back; fails_when=a Priyom station's EiBi name is added to the catalog but not the SQL; why_new=owner D9 (committed filter, contains-all drift check); seam=none; no_claim=that the reports table holds no other spelling
  it("lists every catalog Priyom station's EiBi name", () => {
    const names = new Set(listed(CTE));
    for (const s of SIGNAL_STATIONS) if (s.priyom) for (const n of s.eibi ?? []) expect(names, `${s.slug}: ${n}`).toContain(n);
  });

  // Value: protects=run in Postgres (PGlite), the CTE leaves out exactly the old EiBi answers about Priyom stations, matched on each whole " / " part: alone, as the second part of a joint name, but not an "E11a" lookalike, a broadcaster, an askRule 2 answer, or a signal answer; fails_when=the split or the = match breaks (a LIKE would catch the lookalike), or the askRule or kind conditions drift; why_new=owner D9 (joined-name fixture); seam=PGlite for Postgres; no_claim=the production table's other columns
  it("leaves out old EiBi answers naming a Priyom station, part by part", async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE "ReceptionReport" (id int, "txKind" text, "txName" text, "askRule" int)`);
      await db.exec(`INSERT INTO "ReceptionReport" VALUES
        (1, 'eibi', 'E11 Polish Spy Numbers', NULL),
        (2, 'eibi', 'Sound of Hope / E11 Polish Spy Numbers', 1),
        (3, 'eibi', 'E11a Polish Spy Numbers', 1),
        (4, 'eibi', 'Sound of Hope', 1),
        (5, 'eibi', 'E11 Polish Spy Numbers', 2),
        (6, 'signal', 'e11', NULL),
        (7, 'eibi', 'WWV Colorado (m.ann.) / WWVH Hawaii (f.ann.)', NULL)`);
      const { rows } = await db.query<{ id: number }>(`WITH ${CTE} SELECT id FROM analysed_reports ORDER BY id`);
      expect(rows.map((r) => r.id)).toEqual([3, 4, 5, 6, 7]);
    } finally {
      await db.close();
    }
  });
});
