import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The app's layout.tsx, robots.ts and a station's opengraph-image.tsx, loaded fresh so each reads the stubbed env. */
async function load() {
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "www.skywavehf.com");
  vi.doMock("@vercel/analytics/next", () => ({ Analytics: () => null }));
  const layout = await import("./layout");
  const robots = (await import("./robots")).default;
  return { layout, robots };
}

describe("the site's own address (#103)", () => {
  // Value: protects=layout.tsx's metadataBase is the production domain Vercel names (www.skywavehf.com), so canonical links and link-preview images on every page resolve there, not to the redirecting bare domain; fails_when=layout builds its own address or drops metadataBase; why_new=#103 moved the address into siteUrl (owner's note about the redirect); seam=VERCEL_PROJECT_PRODUCTION_URL stubbed, analytics mocked; no_claim=what Vercel sets (checked live: og:image uses www)
  it("sets layout.tsx's metadataBase to the production domain", async () => {
    const { layout } = await load();
    expect(String(layout.metadata.metadataBase)).toBe("https://www.skywavehf.com/");
  });

  // Value: protects=robots.ts lets crawlers read pages but not the API, and names the sitemap on the production domain; fails_when=the API is crawlable, or the sitemap URL points at another host or path; why_new=#103 robots.txt; seam=env stubbed; no_claim=crawler behaviour
  it("points robots.ts at the sitemap and keeps crawlers off the API", async () => {
    const { robots } = await load();
    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/", disallow: "/api/" },
      sitemap: "https://www.skywavehf.com/sitemap.xml",
    });
  });
});

describe("signals/[slug]/opengraph-image.tsx", () => {
  // Value: protects=#103 each station page has a share card (one per catalog station, 1200x630 PNG) that renders for a live and a defunct station; fails_when=a station has no card, the size drifts, rendering throws at build, or an unknown slug renders an image on demand instead of a 404 (Codex full-branch review: /signals/<junk>/opengraph-image was a 200 PNG); why_new=#103 per-station card (owner asked); seam=none (renders with next/og); no_claim=how each site crops it
  it("builds a 1200x630 card for every station", async () => {
    const og = await import("./signals/[slug]/opengraph-image");
    const { SIGNAL_STATIONS } = await import("@/lib/signal-stations");
    expect(og.size).toEqual({ width: 1200, height: 630 });
    expect(og.generateStaticParams().map((p) => p.slug)).toEqual(SIGNAL_STATIONS.map((s) => s.slug));
    expect(og.dynamicParams).toBe(false);
    expect((await og.default({ params: Promise.resolve({ slug: "zz-junk" }) })).status).toBe(404);
    for (const slug of ["uvb-76", "cherry-ripe"]) {
      const res = await og.default({ params: Promise.resolve({ slug }) });
      expect(res.headers.get("content-type")).toBe("image/png");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }
  });
});
