import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * MapLibre's web worker, served from the installed package. maplibre-gl 6
 * looks for it next to its own module, which the bundler doesn't copy, so the
 * map points it here (setWorkerUrl in ReceiverMap). The worker imports the
 * shared chunk by a relative path, so both are served side by side, under
 * the installed version: an upgrade changes the URL, so a cached worker can
 * never pair with a newer page.
 */
const FILES = new Set(["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]);
const DIST = path.join(process.cwd(), "node_modules/maplibre-gl/dist");

async function installedVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(path.join(DIST, "../package.json"), "utf8")) as { version: string };
  return pkg.version;
}

export async function GET(_req: Request, { params }: { params: Promise<{ version: string; file: string }> }) {
  const { version, file } = await params;
  if (!FILES.has(file) || version !== (await installedVersion())) return new Response("Not found", { status: 404 });
  const body = await readFile(path.join(DIST, file));
  return new Response(body, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
