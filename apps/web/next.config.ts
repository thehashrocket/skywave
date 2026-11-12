import type { NextConfig } from "next";

/**
 * Fails a Vercel build that would put NEXT_PUBLIC_RADIO_TOKEN in a public
 * bundle: with APP_PASSWORD empty, src/proxy.ts lets every request through.
 * Local builds pass, so dev keeps working without a password.
 *
 * NEXT_PUBLIC_SITE_PUBLIC=1 says the site is meant for everyone: the token is
 * then public on purpose, and the radio service's own limits (MAX_SESSIONS and
 * its per-receiver and per-address caps) are what protect it. Shared presets
 * go read-only in that mode (src/server/site.ts).
 */
export function assertRadioTokenGuarded(env: Record<string, string | undefined>): void {
  if (env.VERCEL && env.NEXT_PUBLIC_RADIO_TOKEN && !env.APP_PASSWORD && env.NEXT_PUBLIC_SITE_PUBLIC !== "1") {
    throw new Error(
      "NEXT_PUBLIC_RADIO_TOKEN is set but APP_PASSWORD is empty, so the token would ship " +
        "in public JavaScript. Set APP_PASSWORD for this environment, remove the token, or " +
        "set NEXT_PUBLIC_SITE_PUBLIC=1 if the site is meant to be public.",
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
