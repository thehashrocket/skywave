import { sameSecret } from "@/lib/same-secret";
import { freshnessIssueBody, freshnessReport } from "@/lib/signal-freshness";
import { ACTIVITY_WINDOW_MS } from "@/lib/signal-heard";
import { db } from "@/server/db";
import { getPriyomSchedule, readPriyomFeed } from "@/server/routers/signals";

/**
 * The weekly signal-stations freshness report (#147), for the
 * signal-freshness GitHub Action: `{ report, body }`, where `body` is the issue
 * text. Read-only, and only with `Authorization: Bearer $SIGNAL_FRESHNESS_SECRET`;
 * every other caller, or any call while the secret is unset, gets 401. Actions
 * never gets database credentials. Answers are read summed per listener and
 * only counts leave the route: no listenerId or comment is in the output.
 */
export const dynamic = "force-dynamic";
// A first Priyom fetch on a cold instance takes up to 10 s; the database may be waking.
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.SIGNAL_FRESHNESS_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || !auth || !(await sameSecret(auth, `Bearer ${secret}`)))
    return new Response("Unauthorized", { status: 401 });
  try {
    const now = Date.now();
    // A fresh fetch and its save first (owner D2), then the shared record, so neither check
    // reads a copy or record left old only because nobody visited this week.
    const [rows, schedule] = await Promise.all([
      db.receptionReport.groupBy({
        by: ["txName", "outcome", "listenerId"],
        where: {
          txKind: "signal",
          outcome: { in: ["heard", "not_heard"] },
          createdAt: { gte: new Date(now - ACTIVITY_WINDOW_MS), lte: new Date(now) },
        },
        _count: { _all: true },
      }),
      getPriyomSchedule.refreshNow(),
    ]);
    const feed = await readPriyomFeed(db);
    const report = freshnessReport({
      now,
      tallies: rows.map((r) => ({ txName: r.txName, outcome: r.outcome, listenerId: r.listenerId, n: r._count._all })),
      schedule,
      fetch: getPriyomSchedule.status(),
      feed,
    });
    return Response.json({ report, body: freshnessIssueBody(report) });
  } catch (error) {
    console.warn("signals.freshness: failed:", error);
    const reason = error instanceof Error ? error.message : String(error);
    return Response.json({ status: "failed", reason }, { status: 502 });
  }
}
