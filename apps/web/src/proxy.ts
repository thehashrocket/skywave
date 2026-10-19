import { NextResponse, type NextRequest } from "next/server";

/**
 * Optional password for the whole app: pages, the tRPC API, and the JS bundle
 * that carries NEXT_PUBLIC_RADIO_TOKEN. Off unless APP_PASSWORD is set. Uses
 * HTTP Basic auth; any username works.
 *
 * No `matcher` on purpose, so static assets are covered too.
 */
export async function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();
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

/** Constant-time comparison; hashing first makes both sides the same length. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const ha = await digest(a);
  const hb = await digest(b);
  let diff = 0;
  ha.forEach((byte, i) => (diff |= byte ^ hb[i]!));
  return diff === 0;
}
