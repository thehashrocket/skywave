import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../../../../next.config";
import { GET } from "./route";

const repoRoot = path.resolve(__dirname, "../../../../../../..");
const call = (file: string) =>
  GET(new Request(`http://x/vendor/maplibre/${file}`), { params: Promise.resolve({ file }) });

describe("GET /vendor/maplibre/[file]", () => {
  // Value: protects=the map's worker and the chunk it imports load from our own origin; fails_when=the route stops serving one of them or serves it with a type browsers refuse for a module worker; why_new=maplibre-gl 6 worker (PR 2b); seam=reads the installed package; no_claim=browser worker startup (checked by hand in Chrome)
  it.each(["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"])("serves %s as JavaScript", async (file) => {
    const res = await call(file);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await res.text()).length).toBeGreaterThan(1000);
  });

  // Value: protects=the route can't be used to read other files from the server; fails_when=the allowlist is replaced by a path join on the request; why_new=new file-reading route (PR 2b); seam=none; no_claim=URL decoding by Next (the param arrives decoded)
  it.each(["maplibre-gl.mjs", "../package.json", "..%2Fpackage.json", "maplibre-gl-worker.mjs/../../x"])(
    "refuses %s",
    async (file) => {
      expect((await call(file)).status).toBe(404);
    },
  );

  // Value: protects=production builds ship the files this route reads; fails_when=outputFileTracingIncludes drops a file or the route key, so a deploy serves 500s and the map says "unavailable"; why_new=prod-build check (PR 2b); seam=reads next.config.ts; no_claim=a specific host's packaging
  it("is traced into production builds", () => {
    const includes = config.outputFileTracingIncludes?.["/vendor/maplibre/*"] ?? [];
    expect(includes).toEqual([
      "./node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs",
      "./node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs",
    ]);
  });

  // Value: protects=the worker served here is from the exact maplibre-gl the page bundles (an exact pin, chosen in planning); fails_when=a range or a lockfile drift lets the page and the worker come from different releases; why_new=PR 2b dependency; seam=reads apps/web/package.json and pnpm-lock.yaml; no_claim=npm registry contents
  it("pins maplibre-gl exactly, in the manifest and the lockfile", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "apps/web/package.json"), "utf8"));
    expect(pkg.dependencies["maplibre-gl"]).toBe("6.12.0");
    const lock = await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
    expect(lock).toMatch(/maplibre-gl:\n\s+specifier: 6\.12\.0\n\s+version: 6\.12\.0/);
  });
});
