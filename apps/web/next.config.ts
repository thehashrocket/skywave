import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Next only serves dev resources to localhost by default; without this,
  // opening the app at 127.0.0.1 loads a page whose buttons do nothing.
  allowedDevOrigins: ["127.0.0.1"],
  // The map's worker route reads these from the installed package.
  outputFileTracingIncludes: {
    "/vendor/maplibre/*": [
      "./node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs",
      "./node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs",
    ],
  },
};

export default config;
