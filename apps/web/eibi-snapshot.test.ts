import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { seasonFor } from "./src/lib/eibi";
import {
  keptSitesNotice,
  siteCountsOutput,
  snapshot,
  SNAPSHOT_FETCH_TIMEOUT_MS,
  SNAPSHOT_MAX_BYTES,
  targetsNoteOutput,
} from "./scripts/eibi-snapshot";
import { MIN_AREAS, MIN_COUNTRIES, type TargetTable } from "./src/lib/eibi-targets";
import { MIN_SITES, sitesFromJson, sitesToJson } from "./src/lib/eibi-sites";

const HEADER = "kHz:75;Time(UTC):93;Days:59;ITU:49;Station:201;Lng:49;Target:62;Remarks:135;P:35;Start:60;Stop:60;";

describe("eibi:snapshot", () => {
  // Value: protects=the refresh script asks for the season's file and EiBi's README, keeps the schedule as decoded Latin-1 text with its season and the README as its parsed site table, and refuses to write anything that isn't the schedule or a whole site list (the floor with no bundled table, 80% of the bundled one otherwise); fails_when=a moved file, error page or cut-short README becomes the bundled fallback, or accented names are garbled in it; why_new=owner decision: bundled snapshot; #72 D2/D11 (sites in the same file); seam=fetch; no_claim=eibispace.de's availability
  it("saves the season's file and the site table, and only those", async () => {
    const file = `${HEADER}\r\n9580;0000-2400;;B;Rádio Nacional;P;SAm;;1;;\r\n`;
    const readme = (n: number) =>
      [
        "   IV) Transmitter site codes.",
        "   B:   Brasília 15S47-47W55",
        ...Array.from({ length: n - 1 }, (_, i) => `        f${i.toString(36)}-Filler 10N00-010E00`),
      ].join("\r\n");
    const fetchImpl = vi.fn(
      async (url: string) => new Response(Buffer.from(url.endsWith("README.TXT") ? readme(MIN_SITES) : file, "latin1")),
    );
    const run = () => snapshot("b26", fetchImpl as unknown as typeof fetch);
    const { json, count, siteCount, previousSiteCount } = await run();
    expect(previousSiteCount).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith("http://www.eibispace.de/dx/sked-b26.csv", { redirect: "error", signal: expect.any(AbortSignal) });
    expect(fetchImpl).toHaveBeenCalledWith("http://www.eibispace.de/dx/README.TXT", { redirect: "error", signal: expect.any(AbortSignal) });
    expect([count, siteCount]).toEqual([1, MIN_SITES]);
    const saved = JSON.parse(json);
    expect(saved).toMatchObject({ season: "b26", csv: file });
    expect(saved.sites.B).toEqual({ country: "B", coords: [[-15.7833, -47.9167]] });
    fetchImpl.mockImplementation(async (url: string) => new Response(url.endsWith("README.TXT") ? readme(300) : file));
    await expect(run()).rejects.toThrow(/300 transmitter sites, under the first-parse floor/);
    // Against the bundled table it replaces, a slightly smaller one is taken.
    const bundled = sitesFromJson(saved.sites);
    fetchImpl.mockImplementation(async (url: string) => new Response(url.endsWith("README.TXT") ? readme(990) : file));
    const smaller = await snapshot("b26", fetchImpl as unknown as typeof fetch, bundled);
    // Value: protects=snapshot reports the bundled table's size as previousSiteCount, the "before" in the PR's site_counts line; fails_when=it reports the new size or drops the field, so a shrink reads "990 → 990" or "(none bundled before)"; why_new=siteCountsOutput is tested only with literal counts; seam=fetch; no_claim=the CLI block passing it on to GITHUB_OUTPUT
    expect([smaller.previousSiteCount, smaller.siteCount, smaller.sitesError]).toEqual([MIN_SITES, 990, undefined]);
    fetchImpl.mockImplementation(async () => new Response("<html>moved</html>"));
    await expect(run()).rejects.toThrow(/header/);
    fetchImpl.mockImplementation(async () => new Response("", { status: 404 }));
    await expect(run()).rejects.toThrow(/404/);
  });

  // Value: protects=a README that is down or refused (under 80% of the bundled table) never holds up the season's schedule: the new csv is saved with the bundled sites kept and the reason returned for the log; fails_when=a README problem at a season switch fails the whole snapshot again, or a refused table replaces the bundled one; why_new=#72 /ship Red Team finding (owner chose to fix); seam=fetch; no_claim=the workflow's own log wording
  it("keeps the bundled sites when the README fails, and still saves the season", async () => {
    const file = `${HEADER}\r\n9580;0000-2400;;B;Rádio Nacional;P;SAm;;1;;\r\n`;
    const bundled = sitesFromJson({
      B: { country: "B", coords: [[-15.8, -47.9]] },
      "B-x": { country: "B", coords: [] },
    });
    const csvOk = (readme: () => Promise<Response>) =>
      vi.fn(async (url: string) => (url.endsWith("README.TXT") ? readme() : new Response(Buffer.from(file, "latin1"))));
    for (const [readme, why] of [
      [async () => new Response("", { status: 503 }), /HTTP 503/],
      [
        async () => new Response("   IV) Transmitter site codes.\r\n   B:   Brasília 15S47-47W55"),
        /under 80% of the largest good table's 2/,
      ],
    ] as const) {
      const { json, sitesError } = await snapshot("b26", csvOk(readme) as unknown as typeof fetch, bundled);
      expect(sitesError).toMatch(why);
      expect(JSON.parse(json)).toEqual({ season: "b26", csv: file, sites: sitesToJson(bundled) });
    }
    // The season's own file failing still fails the run.
    const csvDown = vi.fn(async () => new Response("", { status: 404 }));
    await expect(snapshot("b26", csvDown as unknown as typeof fetch, bundled)).rejects.toThrow(/404/);
  });

  // Value: protects=each download gives up after the timeout, the body read included: a README that stalls keeps the bundled sites and still saves the season, while a schedule that stalls fails the run instead of saving a partial snapshot; fails_when=a fetch has no timeout (the job hangs until GitHub's six-hour limit), the signal doesn't reach the body read, or a stalled README fails the season; why_new=#72 follow-up TODO (owner D5); seam=fetch (a fake that stalls until its signal aborts); no_claim=real network stalls, or the 30 s value
  it("gives up on a download that stalls", async () => {
    expect(SNAPSHOT_FETCH_TIMEOUT_MS).toBe(30_000);
    const file = `${HEADER}\r\n9580;0000-2400;;B;Rádio Nacional;P;SAm;;1;;\r\n`;
    const bundled = sitesFromJson({ B: { country: "B", coords: [[-15.8, -47.9]] } });
    const stalled = (signal: AbortSignal) =>
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    // Headers arrive, then the body never finishes.
    const stalledBody = (signal: AbortSignal) =>
      new Response(new ReadableStream({ start: (c) => signal.addEventListener("abort", () => c.error(signal.reason)) }));
    for (const readme of [stalled, stalledBody]) {
      const fetchImpl = vi.fn(async (url: string, init: RequestInit) =>
        url.endsWith("README.TXT") ? readme(init.signal!) : new Response(Buffer.from(file, "latin1")),
      );
      const { json, sitesError } = await snapshot("b26", fetchImpl as unknown as typeof fetch, bundled, 20);
      expect(sitesError).toMatch(/timeout|aborted/i);
      expect(JSON.parse(json)).toEqual({ season: "b26", csv: file, sites: sitesToJson(bundled) });
    }
    const csvStalled = vi.fn(async (_url: string, init: RequestInit) => stalled(init.signal!));
    await expect(snapshot("b26", csvStalled as unknown as typeof fetch, bundled, 20)).rejects.toThrow(/timeout|aborted/i);
  });

  // Value: protects=a response far larger than EiBi's real files is refused instead of buffered whole: an oversized README keeps the bundled sites, an oversized schedule fails the run; fails_when=the script reads bodies with no size cap (a huge or endless body exhausts the runner's memory); why_new=#72 follow-up, /ship Step 11 outside-voice finding (owner D10); seam=fetch; no_claim=the exact 3 MB value, or memory behaviour on GitHub's runners
  it("refuses a download larger than EiBi's files", async () => {
    expect(SNAPSHOT_MAX_BYTES).toBe(3_000_000);
    const file = `${HEADER}\r\n9580;0000-2400;;B;Rádio Nacional;P;SAm;;1;;\r\n`;
    const bundled = sitesFromJson({ B: { country: "B", coords: [[-15.8, -47.9]] } });
    const huge = () => new Response(Buffer.alloc(SNAPSHOT_MAX_BYTES + 1, 0x20));
    const readmeHuge = vi.fn(async (url: string) => (url.endsWith("README.TXT") ? huge() : new Response(Buffer.from(file, "latin1"))));
    const { json, sitesError } = await snapshot("b26", readmeHuge as unknown as typeof fetch, bundled);
    expect(sitesError).toMatch(/README\.TXT is larger than expected/);
    expect(JSON.parse(json)).toEqual({ season: "b26", csv: file, sites: sitesToJson(bundled) });
    const csvHuge = vi.fn(async () => huge());
    await expect(snapshot("b26", csvHuge as unknown as typeof fetch, bundled)).rejects.toThrow(/sked-b26\.csv is larger than expected/);
  });

  // Value: protects=the seasonal PR shows the bundled table's site count and the new one's, and an open PR's body is refreshed (with the same composed text) when a rerun pushes to it; fails_when=a shrinking table is invisible in review, the workflow stops passing the counts, or a rerun leaves the PR describing an older commit; why_new=#72 follow-up TODO and review note (owner D5); seam=reads .github/workflows/eibi-snapshot.yml as text; no_claim=GitHub accepting the edit
  it("puts the site counts in the PR and refreshes an open PR's body", () => {
    expect(siteCountsOutput(1698, 1690)).toBe("site_counts=Transmitter sites: 1,698 → 1,690.\n");
    expect(siteCountsOutput(undefined, 1690)).toBe("site_counts=Transmitter sites: 1,690 (none bundled before).\n");
    const workflow = readFileSync(new URL("../../.github/workflows/eibi-snapshot.yml", import.meta.url), "utf8");
    expect(workflow).toContain("SITE_COUNTS: ${{ steps.snapshot.outputs.site_counts }}");
    expect(workflow).toMatch(/body="[^"]*\$checked \$SITE_COUNTS/);
    expect(workflow).toContain('gh pr create --head "$branch" --base "$BASE" --title "$title" --body "$body"');
    expect(workflow).toContain('gh pr edit "$branch" --body "$body"');
  });

  // Value: protects=a kept site table is visible in GitHub: a ::warning:: annotation on the run, and a one-line sites_note step output the workflow puts in the PR body instead of claiming both files were refreshed; fails_when=a README that keeps failing only leaves a plain log line, a multi-line reason breaks the step output, or the workflow stops passing the note; why_new=#72 /ship review (owner: fix now); seam=reads .github/workflows/eibi-snapshot.yml as text; no_claim=GitHub rendering the annotation
  it("makes a kept site table visible on the run and in the PR", () => {
    const { warning, output } = keptSitesNotice("EiBi README request failed: HTTP 503\nretry later");
    expect(warning).toBe(
      "::warning title=EiBi transmitter sites not refreshed::Kept the bundled transmitter sites: EiBi README request failed: HTTP 503 retry later",
    );
    expect(output).toBe(
      "sites_note=Kept the bundled transmitter sites: EiBi README request failed: HTTP 503 retry later\n",
    );
    const workflow = readFileSync(new URL("../../.github/workflows/eibi-snapshot.yml", import.meta.url), "utf8");
    expect(workflow).toMatch(/name: Fetch the season's schedule\n\s+id: snapshot\n/);
    expect(workflow).toContain("SITES_NOTE: ${{ steps.snapshot.outputs.sites_note }}");
    expect(workflow).toContain("The transmitter sites were NOT refreshed: $SITES_NOTE");
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

describe("eibi:snapshot target names (station search)", () => {
  const csv = `${HEADER}\r\n9580;0000-2400;;KOR;A;E;FE;k;1;;\r\n6180;0000-2400;;CHN;B;E;WAf;;1;;\r\n7200;0000-2400;;AUS;C;;Tas;;1;;\r\n7300;0000-2400;;CHN;D;E;Qq;;1;;\r\n7400;0000-2400;;CHN;E;E;;;1;;\r\n`;
  /** A README with whole country, target-area and site lists, or only the sites. */
  const readme = (withTargets: boolean) =>
    [
      ...(withTargets
        ? [
            "   II) Country codes.",
            "   CHN  China (People's Republic)",
            ...Array.from({ length: MIN_COUNTRIES }, (_, i) => `   Q${i.toString(36).padStart(2, "0").toUpperCase()}  Filler ${i}`),
            "",
            "   III) Target-area codes.",
            "   Af  - Africa",
            "   FE  - Far East",
            "   W.. - West ..",
            ...Array.from({ length: MIN_AREAS }, (_, i) => `   Zz${i.toString(36)} - Filler ${i}`),
            "",
          ]
        : []),
      "   IV) Transmitter site codes.",
      "   B:   Brasília 15S47-47W55",
      ...Array.from({ length: MIN_SITES - 1 }, (_, i) => `        f${i.toString(36)}-Filler 10N00-010E00`),
    ].join("\r\n");
  const fetchWith = (readmeText: string) =>
    (async (url: string) =>
      new Response(Buffer.from(url.endsWith("README.TXT") ? readmeText : csv, "latin1"))) as unknown as typeof fetch;

  // Value: protects=the refresh saves the README's target names with the season, from the same single README download as the sites, and reports the season's codes left unnamed except the known-unnamed Tas and blanks; fails_when=the names aren't saved, the README is fetched twice, or a new code goes unreported; why_new=station search re-check D5/D3; seam=fetch; no_claim=EiBi's real README (the parser's own tests use its lines)
  it("saves the README's target names and lists unnamed codes", async () => {
    const fetchImpl = vi.fn(fetchWith(readme(true)));
    const { json, targetsError, unnamed } = await snapshot("b26", fetchImpl as unknown as typeof fetch);
    const saved = JSON.parse(json);
    expect(saved.targets.areas.FE).toBe("Far East");
    expect(saved.targets.prefixes).toEqual({ W: "West" });
    expect(saved.targets.countries.CHN).toBe("China");
    expect(targetsError).toBeUndefined();
    expect(unnamed).toEqual(["Qq"]);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("README.TXT"))).toHaveLength(1);
  });

  // Value: protects=a README without whole target lists never holds up the season or drops names: the bundled names are kept and the reason returned, and with none bundled the snapshot saves without names rather than failing; fails_when=a README problem fails the snapshot, or a short list replaces good names; why_new=station search re-check D5 (as for sites); seam=fetch; no_claim=the workflow's log wording
  it("keeps the bundled names when the README's lists aren't whole", async () => {
    const bundled: TargetTable = { areas: { FE: "Far East" }, countries: { CHN: "China" }, prefixes: {} };
    const kept = await snapshot("b26", fetchWith(readme(false)), undefined, SNAPSHOT_FETCH_TIMEOUT_MS, bundled);
    expect(JSON.parse(kept.json).targets).toEqual(bundled);
    expect(kept.targetsError).toMatch(/no country or target-area section/);
    expect(kept.unnamed).toEqual(["Qq", "WAf"]);
    const none = await snapshot("b26", fetchWith(readme(false)));
    expect(JSON.parse(none.json)).not.toHaveProperty("targets");
    expect(none.unnamed).toEqual([]);
  });

  // Value: protects=kept names and unnamed codes reach the snapshot PR body as one line, since CI doesn't run on that PR, and nothing is said when there's nothing to say; fails_when=the output breaks on a multi-line reason, a remote code reaches the body bare (an @-mention or Markdown), or the workflow stops passing the note; why_new=station search re-check D3; seam=reads .github/workflows/eibi-snapshot.yml as text; no_claim=GitHub rendering the body
  it("puts the target note in the PR body", () => {
    expect(targetsNoteOutput(undefined, [])).toBe("");
    expect(targetsNoteOutput(undefined, ["Qq", "Zx"])).toBe("targets_note=Target codes with no name in EiBi's README: `Qq`, `Zx`.\n");
    // Codes come from the remote schedule: each sits in a code span, so none can ping or render.
    expect(targetsNoteOutput(undefined, ["@x`y"])).toBe("targets_note=Target codes with no name in EiBi's README: `@xy`.\n");
    expect(targetsNoteOutput("README request failed: HTTP 503\nlater", ["Qq"])).toBe(
      "targets_note=Kept the bundled target names: README request failed: HTTP 503 later Target codes with no name in EiBi's README: `Qq`.\n",
    );
    const workflow = readFileSync(new URL("../../.github/workflows/eibi-snapshot.yml", import.meta.url), "utf8");
    expect(workflow).toContain("TARGETS_NOTE: ${{ steps.snapshot.outputs.targets_note }}");
    expect(workflow).toMatch(/body="[^"]*\$checked \$SITE_COUNTS \$TARGETS_NOTE/);
  });
});
