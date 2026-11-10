import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { seasonFor } from "./src/lib/eibi";
import { snapshot } from "./scripts/eibi-snapshot";

const HEADER = "kHz:75;Time(UTC):93;Days:59;ITU:49;Station:201;Lng:49;Target:62;Remarks:135;P:35;Start:60;Stop:60;";

describe("eibi:snapshot", () => {
  // Value: protects=the refresh script asks for the season's file, keeps it as decoded Latin-1 text with its season, and refuses to write anything that isn't the schedule; fails_when=a moved file or error page becomes the bundled fallback, or accented names are garbled in it; why_new=owner decision: bundled snapshot; seam=fetch; no_claim=eibispace.de's availability
  it("saves the season's file, and only the schedule", async () => {
    const file = `${HEADER}\r\n9580;0000-2400;;B;Rádio Nacional;P;SAm;;1;;\r\n`;
    const fetchImpl = vi.fn(async () => new Response(Buffer.from(file, "latin1")));
    const { json, count } = await snapshot("b26", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("http://www.eibispace.de/dx/sked-b26.csv", { redirect: "error" });
    expect(count).toBe(1);
    expect(JSON.parse(json)).toEqual({ season: "b26", csv: file });
    fetchImpl.mockImplementation(async () => new Response("<html>moved</html>"));
    await expect(snapshot("b26", fetchImpl as unknown as typeof fetch)).rejects.toThrow(/header/);
    fetchImpl.mockImplementation(async () => new Response("", { status: 404 }));
    await expect(snapshot("b26", fetchImpl as unknown as typeof fetch)).rejects.toThrow(/404/);
  });

  // Value: protects=the seasonal workflow runs the script package.json really has, its season check accepts every name seasonFor makes, and each scheduled run lands just after a season switch and asks for that new season; fails_when=the script is renamed and the workflow fails twice a year, the check rejects a real season, or a cron date drifts before a switch (fetching the old season again); why_new=TODOS: refresh the bundled schedule each season; seam=reads .github/workflows/eibi-snapshot.yml as text; no_claim=GitHub running it, or EiBi posting on time
  it("runs from the seasonal workflow, just after each switch", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/eibi-snapshot.yml", import.meta.url), "utf8");
    const scripts = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).scripts;
    expect(workflow).toContain("pnpm --filter web eibi:snapshot");
    expect(scripts["eibi:snapshot"]).toBe("tsx scripts/eibi-snapshot.ts");
    const check = new RegExp(/\[\[ "\$SEASON" =~ (\S+) \]\]/.exec(workflow)![1]!);
    const crons = [...workflow.matchAll(/cron: "0 6 (\d+) (\d+) \*"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(crons).toEqual([
      [1, 4],
      [1, 11],
    ]);
    for (const year of [2026, 2027, 2030, 2031]) {
      for (const [day, month] of crons) {
        const run = Date.UTC(year, month! - 1, day!, 6);
        const season = seasonFor(run);
        expect(season).toMatch(check);
        // A new season, not the one a week earlier.
        expect(season).not.toBe(seasonFor(run - 8 * 86_400_000));
      }
    }
  });
});
