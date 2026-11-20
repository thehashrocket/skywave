import { sameSecret } from "@/lib/same-secret";
import { saveSkimmerDay } from "@/server/routers/beacons";

/**
 * Saves today's RBN skimmer list (#61, D14). Vercel's cron calls it twice a
 * day (apps/web/vercel.json) with `Authorization: Bearer $CRON_SECRET`; every
 * other caller, or any call while CRON_SECRET is unset, gets 401 and fetches
 * nothing. 200 says "saved" or "kept" (already saved today); 502 says why a
 * fetch or parse failed, in Vercel's cron log, and leaves the day for the next run.
 */
export const dynamic = "force-dynamic";
// The RBN fetch alone may take 30 s; leave room to save and answer before the platform stops the call.
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || !auth || !(await sameSecret(auth, `Bearer ${secret}`)))
    return new Response("Unauthorized", { status: 401 });
  try {
    return Response.json(await saveSkimmerDay());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("cron.rbn-skimmers: not saved:", error);
    return Response.json({ status: "failed", reason }, { status: 502 });
  }
}
