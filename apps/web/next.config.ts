import type { NextConfig } from "next";

/**
 * Fails a Vercel build that would put NEXT_PUBLIC_RADIO_TOKEN in a public
 * bundle: with APP_PASSWORD empty, src/proxy.ts lets every request through.
 * Local builds pass, so dev keeps working without a password.
 */
export function assertRadioTokenGuarded(env: Record<string, string | undefined>): void {
  if (env.VERCEL && env.NEXT_PUBLIC_RADIO_TOKEN && !env.APP_PASSWORD) {
    throw new Error(
      "NEXT_PUBLIC_RADIO_TOKEN is set but APP_PASSWORD is empty, so the token would ship " +
        "in public JavaScript. Set APP_PASSWORD for this environment, or remove the token.",
    );
  }
}

assertRadioTokenGuarded(process.env);

const config: NextConfig = {
  reactStrictMode: true,
  // Next only serves dev resources to localhost by default; without this,
  // opening the app at 127.0.0.1 loads a page whose buttons do nothing.
  allowedDevOrigins: ["127.0.0.1"],
  // The map's worker route reads these from the installed package.
  outputFileTracingIncludes: {
    "/vendor/maplibre/**": [
      "./node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs",
      "./node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs",
      "./node_modules/maplibre-gl/package.json",
    ],
  },
};

export default config;
