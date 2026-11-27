import { NextResponse, type NextRequest } from "next/server";
import { sameSecret } from "@/lib/same-secret";

/**
 * Optional password for the whole app: pages, the tRPC API, and the JS bundle
 * that carries NEXT_PUBLIC_RADIO_TOKEN. Off unless APP_PASSWORD is set. Uses
 * HTTP Basic auth; any username works.
 *
 * No `matcher` on purpose, so static assets are covered too. The one
 * exception is `/api/cron/`: Vercel's cron calls it with its own bearer
 * secret, never the site password, and each cron route refuses any call
 * without CRON_SECRET itself. Gating it here too would silently stop the
 * daily RBN skimmer snapshots whenever Production is password-locked (#61, D1).
 * The weekly freshness report (/api/signals/freshness, #147) is the same: the
 * GitHub Action brings its own bearer secret, which the route checks.
 */
export async function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  const path = request.nextUrl.pathname;
  if (!password || path.startsWith("/api/cron/") || path === "/api/signals/freshness") return NextResponse.next();
  const supplied = basicAuthPassword(request.headers.get("authorization"));
  if (supplied !== null && (await sameSecret(supplied, password))) return NextResponse.next();
  return new NextResponse("Password required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="skywave", charset="UTF-8"' },
  });
}

/** The password half of an `Authorization: Basic …` header, or null. */
function basicAuthPassword(header: string | null): string | null {
  const match = header?.match(/^Basic\s+(\S+)$/i);
  if (!match) return null;
  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(match[1]!), (c) => c.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1);
}
