import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * MapLibre's web worker, served from the installed package. maplibre-gl 6
 * looks for it next to its own module, which the bundler doesn't copy, so the
 * map points it here (setWorkerUrl in ReceiverMap). The worker imports the
 * shared chunk by a relative path, so both are served side by side.
 */
const FILES = new Set(["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]);

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!FILES.has(file)) return new Response("Not found", { status: 404 });
  const body = await readFile(path.join(process.cwd(), "node_modules/maplibre-gl/dist", file));
  return new Response(body, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" },
  });
}
