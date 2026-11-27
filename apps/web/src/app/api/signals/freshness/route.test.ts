import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const groupBy = vi.fn();
const findUnique = vi.fn();
// Shared-frequency answers' tallies (#150, server/grouped-tallies.ts); none unless a test sets them.
const queryRaw = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock("@/server/db", () => ({ db: { receptionReport: { groupBy }, priyomFeed: { findUnique }, $queryRawUnsafe: queryRaw } }));
const getPriyomSchedule = Object.assign(vi.fn(), { status: vi.fn(), refreshNow: vi.fn() });
vi.mock("@/server/routers/signals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/routers/signals")>()),
  getPriyomSchedule,
}));
const { GET } = await import("./route");
const { SIGNAL_STATIONS } = await import("@/lib/signal-stations");
const { NOT_HEARD_OVER_OTHER } = await import("@/lib/signal-heard");
const { groupedTalliesSql } = await import("@/server/grouped-tallies");

const call = (auth?: string) =>
  GET(new Request("https://skywave.test/api/signals/freshness", { headers: auth ? { authorization: auth } : {} }));

describe("signal freshness route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // Value: protects=#147 only the GitHub Action with the bearer secret gets the report: no header, a wrong one, the bare secret, or any call while SIGNAL_FRESHNESS_SECRET is unset or empty gets 401 and reads nothing; fails_when=an unset secret lets every caller in (Bearer undefined) or the check is skipped; why_new=#147 route; seam=db and Priyom source mocked; no_claim=the Action sending it
  it("refuses any caller without the secret", async () => {
    vi.stubEnv("SIGNAL_FRESHNESS_SECRET", undefined);
    expect((await call("Bearer undefined")).status).toBe(401);
    vi.stubEnv("SIGNAL_FRESHNESS_SECRET", "");
    expect((await call("Bearer")).status).toBe(401);
    vi.stubEnv("SIGNAL_FRESHNESS_SECRET", "s3cret");
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call("s3cret")).status).toBe(401);
    expect(groupBy).not.toHaveBeenCalled();
    expect(getPriyomSchedule.refreshNow).not.toHaveBeenCalled();
  });

  // Value: protects=#147 an authorized call reads 60 days of heard/not-heard answers summed per listener, the shared Priyom record and this server's copy, and returns the report and issue body, with no listenerId or comment anywhere in the output; fails_when=the read window or outcomes drift, the shape breaks the workflow (report.empty, body), or a listener's id leaks; why_new=#147 acceptance; seam=db and Priyom source mocked; no_claim=Prisma's SQL
  it("returns the report without listener ids", async () => {
    vi.stubEnv("SIGNAL_FRESHNESS_SECRET", "s3cret");
    vi.useFakeTimers({ now: Date.parse("2026-12-07T15:00:00Z"), toFake: ["Date"] });
    groupBy.mockResolvedValue(
      ["listener-aaa", "listener-bbb", "listener-ccc"].map((id) => ({ txName: "uvb-76", outcome: "not_heard", listenerId: id, _count: { _all: 2 } })),
    );
    findUnique.mockResolvedValue({
      id: "priyom",
      transmissions: [],
      fetchedAt: new Date("2026-12-07T09:00:00Z"),
      trackedSince: new Date("2026-11-28T00:00:00Z"),
      changedAt: new Date("2026-12-01T00:00:00Z"),
    });
    getPriyomSchedule.refreshNow.mockResolvedValue({ transmissions: [], fetchedAt: Date.parse("2026-12-07T09:00:00Z") });
    getPriyomSchedule.status.mockReturnValue({ fetchedAt: Date.parse("2026-12-07T09:00:00Z"), error: null });

    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("listener-");
    expect(text).not.toMatch(/listenerId|comment/);
    const { report, body } = JSON.parse(text);
    const window = {
      txKind: "signal",
      outcome: { in: ["heard", "not_heard"] },
      createdAt: { gte: new Date("2026-10-08T15:00:00Z"), lte: new Date("2026-12-07T15:00:00Z") },
    };
    expect(groupBy).toHaveBeenCalledWith({
      by: ["txName", "outcome", "listenerId"],
      where: { ...window, askGroup: null },
      _count: { _all: true },
    });
    // Shared-frequency answers are summed by the database too, by listener, over the same window.
    expect(queryRaw).toHaveBeenCalledWith(groupedTalliesSql(true), window.createdAt.gte, window.createdAt.lte);
    expect(report.suspect).toEqual([expect.objectContaining({ slug: "uvb-76", notHeard: 6, listeners: 3 })]);
    expect(report.priyom).toMatchObject({ changedAt: "2026-12-01T00:00:00.000Z", unchanged: false, error: null });
    const priyomIds = SIGNAL_STATIONS.filter((s) => s.priyom && s.schedule.kind !== "defunct").map((s) => s.priyom);
    expect(report.priyom.missing.map((m: { designator: string }) => m.designator)).toEqual(priyomIds);
    expect(report.empty).toBe(false);
    expect(body).toContain("### Possibly off the air");
  });

  // Value: protects=#150 owner rule wired into the weekly report: the database's grouped tallies are added to the single-station ones, so WWVH answered only as "not heard over the other" (three listeners, twice each) is neither suspect nor listed as unanswered, while plain grouped not-heards ("Heard nothing") make both suspect; fails_when=grouped tallies are dropped from the report or the over-other ones are counted as not heard; why_new=#150 review; seam=db and Priyom source mocked (the SQL itself is in grouped-tallies.test); no_claim=Prisma's parameter binding
  it("leaves out WWVH not heard over WWV, and counts heard nothing", async () => {
    vi.stubEnv("SIGNAL_FRESHNESS_SECRET", "s3cret");
    groupBy.mockResolvedValue([]);
    findUnique.mockResolvedValue(null);
    getPriyomSchedule.refreshNow.mockResolvedValue({ transmissions: [], fetchedAt: Date.now() });
    getPriyomSchedule.status.mockReturnValue({ fetchedAt: Date.now(), error: null });
    const tallies = (wwv: string, wwvh: string) =>
      ["a", "b", "c"].flatMap((listenerId) => [
        { txName: "wwv", outcome: wwv, listenerId, n: 2 },
        { txName: "wwvh", outcome: wwvh, listenerId, n: 2 },
      ]);
    queryRaw.mockResolvedValueOnce(tallies("heard", NOT_HEARD_OVER_OTHER));
    const overWwv = (await (await call("Bearer s3cret")).json()).report;
    expect(overWwv.suspect).toEqual([]);
    // Someone did answer about WWVH: it isn't listed as having no answers either.
    expect(overWwv.quiet.map((s: { slug: string }) => s.slug)).not.toContain("wwvh");
    queryRaw.mockResolvedValueOnce(tallies("not_heard", "not_heard"));
    const nothing = (await (await call("Bearer s3cret")).json()).report;
    expect(nothing.suspect.map((s: { slug: string }) => s.slug)).toEqual(["wwv", "wwvh"]);
  });

  // Value: protects=#147 review D2: the route reads the shared Priyom record only after its own forced refresh and save finished, so a week with no visitors doesn't read as a stale record or copy; fails_when=the record read runs in parallel with (or before) the refresh again, flagging a healthy feed and keeping the issue open; why_new=owner chose to stop false alarms after quiet days; seam=db and Priyom source mocked; no_claim=Next's after() timing in production
  it("reads the shared record after its own refresh and save", async () => {
    vi.stubEnv("SIGNAL_FRESHNESS_SECRET", "s3cret");
    const order: string[] = [];
    groupBy.mockResolvedValue([]);
    getPriyomSchedule.refreshNow.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("refreshed and saved");
      return { transmissions: [], fetchedAt: Date.now() };
    });
    getPriyomSchedule.status.mockReturnValue({ fetchedAt: Date.now(), error: null });
    findUnique.mockImplementation(async () => {
      order.push("record read");
      return null;
    });
    expect((await call("Bearer s3cret")).status).toBe(200);
    expect(order).toEqual(["refreshed and saved", "record read"]);
    expect(getPriyomSchedule).not.toHaveBeenCalled();
  });

  // Value: protects=#147 a failed database read returns 502 with the reason, so the workflow fails loudly instead of closing the issue on an empty-looking report; fails_when=an error reads as "nothing stale"; why_new=#147; seam=db mocked; no_claim=none
  it("fails loudly when the database read fails", async () => {
    vi.stubEnv("SIGNAL_FRESHNESS_SECRET", "s3cret");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    groupBy.mockRejectedValue(new Error("connection refused"));
    findUnique.mockResolvedValue(null);
    getPriyomSchedule.refreshNow.mockResolvedValue(null);
    const res = await call("Bearer s3cret");
    expect([res.status, await res.json()]).toEqual([502, { status: "failed", reason: "connection refused" }]);
  });

  // Value: protects=whoever deploys finds SIGNAL_FRESHNESS_SECRET in .env.example, and the workflow sends the same secret to this route and keeps one issue labelled signal-stations + freshness, closing it when the report is empty; fails_when=the names drift apart so every run gets 401, or the workflow opens a new issue each week; why_new=#147; seam=reads .env.example and the workflow as text; no_claim=GitHub running it
  it("is wired to the weekly workflow", () => {
    const example = readFileSync(new URL("../../../../../.env.example", import.meta.url), "utf8");
    expect(example).toMatch(/^SIGNAL_FRESHNESS_SECRET=$/m);
    const workflow = readFileSync(new URL("../../../../../../../.github/workflows/signal-freshness.yml", import.meta.url), "utf8");
    expect(workflow).toContain("secrets.SIGNAL_FRESHNESS_SECRET");
    expect(workflow).toContain("/api/signals/freshness");
    expect(workflow).toMatch(/--label signal-stations --label freshness/);
    expect(workflow).toContain("gh issue edit");
    expect(workflow).toContain("gh issue close");
    expect(workflow).toMatch(/cron: "[^"]+ \* \* 1"/);
  });
});
