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

// Read once per server process; the installed package doesn't change under it.
let installed: Promise<string> | undefined;
function installedVersion(): Promise<string> {
  installed ??= readFile(path.join(DIST, "../package.json"), "utf8").then(
    (text) => (JSON.parse(text) as { version: string }).version,
  );
  return installed;
}

const notFound = () => new Response("Not found", { status: 404 });

export async function GET(_req: Request, { params }: { params: Promise<{ version: string; file: string }> }) {
  const { version, file } = await params;
  if (!FILES.has(file)) return notFound();
  try {
    if (version !== (await installedVersion())) return notFound();
    const body = await readFile(path.join(DIST, file));
    return new Response(body, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    // Files missing from a deploy: the map says it's unavailable; this isn't a server error.
    installed = undefined;
    return notFound();
  }
}
