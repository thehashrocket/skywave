import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { SERVER_MS_HEADER } from "@/lib/server-clock";
import { appRouter } from "@/server/root";
import { createContext } from "@/server/trpc";

/**
 * Every reply carries the server's time in milliseconds (lib/server-clock.ts):
 * the Date header has whole seconds only, and the beacon schedule runs in 10 s
 * slots. Stamped as the reply leaves, inside the request's round trip, which
 * is what the page reads it against.
 */
const handler = async (req: Request) => {
  const res = await fetchRequestHandler({ endpoint: "/api/trpc", req, router: appRouter, createContext });
  const stamped = new Response(res.body, res);
  stamped.headers.set(SERVER_MS_HEADER, String(Date.now()));
  return stamped;
};

export { handler as GET, handler as POST };
