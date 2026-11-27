// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The live half needs the server clock and tRPC; its own test covers it.
vi.mock("@/components/SignalLive", () => ({ SignalLive: ({ slug }: { slug: string }) => <p data-live={slug} /> }));

const { default: SignalStationPage, generateMetadata, generateStaticParams } = await import("./page");
const { default: SignalStationsIndex } = await import("../page");
const { default: sitemap } = await import("../../sitemap");
const { SIGNAL_STATIONS } = await import("@/lib/signal-stations");

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("/signals/[slug]", () => {
  // Value: protects=#103 a live station's page names it, says where it's sent from, lists each channel with a Tune link that opens skywave tuned to it with the station named, links its sources by site name, and mounts the live line; fails_when=a channel loses its link, the link drops sig=, or the sources vanish; why_new=#103 pages; seam=SignalLive mocked; no_claim=layout
  it("shows a live station with Tune links and sources", async () => {
    render(await SignalStationPage(params("uvb-76")));
    expect(screen.getByRole("heading", { level: 1, name: "UVB-76" })).toBeTruthy();
    expect(screen.getByText(/Also called The Buzzer/)).toBeTruthy();
    const tune = screen.getByRole("link", { name: "Tune UVB-76 on 4.625 USB" });
    expect(tune.getAttribute("href")).toBe("/?f=4625&m=usb&sig=uvb-76");
    const sources = screen.getByRole("heading", { name: "Read more" }).parentElement!;
    expect(within(sources).getAllByRole("link").length).toBeGreaterThan(0);
    // #147: when the entry was last checked against those sources (2026-11-24).
    expect(within(sources).getByText("Details checked Nov 2026")).toBeTruthy();
    expect(document.querySelector('[data-live="uvb-76"]')).toBeTruthy();
  });

  // Value: protects=#103 a station off the air for good gets its history and no Listen or Tune link (nothing to tune) and no live line; fails_when=a defunct page offers a link that tunes dead air; why_new=#103 defunct rule; seam=SignalLive mocked; no_claim=none
  it("shows a defunct station's history with nothing to tune", async () => {
    render(await SignalStationPage(params("lincolnshire-poacher")));
    expect(screen.getByRole("heading", { name: "History" })).toBeTruthy();
    expect(screen.getByText("Off the air since 2008-07.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Tune / })).toBeNull();
    expect(document.querySelector("[data-live]")).toBeNull();
  });

  // Value: protects=a numbers station (no fixed frequency) points to Priyom's schedule with its licence and opens skywave with the station named, not a made-up frequency; fails_when=it offers a Tune link with no channel or loses the Priyom credit; why_new=#103 pages; seam=SignalLive mocked; no_claim=Priyom's data
  it("sends a numbers station to Priyom's schedule and the panel", async () => {
    render(await SignalStationPage(params("e11")));
    expect(screen.getByRole("link", { name: "Priyom’s schedule" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open it in skywave" }).getAttribute("href")).toBe("/?sig=e11");
    expect(screen.queryByRole("link", { name: /^Tune / })).toBeNull();
  });

  // Value: protects=#103 a page says where the station is sent from and flags a reported area as such, and names each source by its site (Wikipedia, NIST, Priyom) rather than a raw host; fails_when=the transmitter section vanishes, an approximate site reads as exact, or sourceName mislabels a source; why_new=the existing page tests only count source links and never read the transmitter section; seam=SignalLive mocked; no_claim=catalog facts
  it("says where it's sent from and names its sources by site", async () => {
    render(await SignalStationPage(params("uvb-76")));
    const where = screen.getByRole("heading", { name: "Where it’s sent from" }).parentElement!;
    expect(where.textContent).toContain("Naro-Fominsk, Russia (reported area)");
    expect(screen.getByRole("link", { name: "Wikipedia" }).getAttribute("href")).toBe("https://en.wikipedia.org/wiki/UVB-76");
    cleanup();
    render(await SignalStationPage(params("wwv")));
    const known = screen.getByRole("heading", { name: "Where it’s sent from" }).parentElement!;
    expect(known.textContent).toContain("Fort Collins, Colorado");
    expect(known.textContent).not.toContain("(");
    const sources = screen.getByRole("heading", { name: "Read more" }).parentElement!;
    expect(within(sources).getAllByRole("link").map((a) => a.textContent)).toEqual(["NIST", "Wikipedia"]);
    cleanup();
    render(await SignalStationPage(params("e11")));
    expect(screen.getByRole("link", { name: "Priyom" })).toBeTruthy();
  });

  // Value: protects=one static page per catalog station, an unknown slug is a 404, and each page's title, description and canonical name the station (live: "listen live"; defunct: not); fails_when=a station has no page, unknown slugs render, or a defunct station is titled "listen live"; why_new=#103 metadata; seam=none; no_claim=how search engines rank it
  it("builds a page per station with its own metadata", async () => {
    expect(generateStaticParams().map((p) => p.slug)).toEqual(SIGNAL_STATIONS.map((s) => s.slug));
    await expect(SignalStationPage(params("nope"))).rejects.toThrow();
    const live = await generateMetadata(params("uvb-76"));
    expect(live.title).toBe("UVB-76 (The Buzzer): listen live · skywave");
    expect(live.alternates?.canonical).toBe("/signals/uvb-76");
    const gone = await generateMetadata(params("cherry-ripe"));
    expect(String(gone.title)).not.toMatch(/listen live/);
  });
});

describe("/signals", () => {
  // Value: protects=the index links every catalog station's page once, with defunct stations under "Off the air"; fails_when=a station is missing from the index or history is mixed into the live groups; why_new=#103 index (owner asked); seam=none; no_claim=layout
  it("links every station, history last", () => {
    render(<SignalStationsIndex />);
    for (const s of SIGNAL_STATIONS) expect(screen.getByRole("link", { name: s.name }).getAttribute("href")).toBe(`/signals/${s.slug}`);
    const history = screen.getByRole("heading", { name: "Off the air" }).parentElement!;
    expect(within(history).getAllByRole("link").map((a) => a.textContent)).toEqual(["CHU", "Lincolnshire Poacher", "Cherry Ripe"]);
  });
});

describe("sitemap", () => {
  // Value: protects=the sitemap lists the main page, /owners, /signals and every station page on the site's own address (www.skywavehf.com in production), never the redirecting bare domain; fails_when=a station page is missing or URLs use another host than metadataBase; why_new=#103 sitemap, owner's note about the redirect; seam=VERCEL_PROJECT_PRODUCTION_URL stubbed; no_claim=what Vercel sets in production (checked live: og:image uses www)
  it("lists every page on the production address", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "www.skywavehf.com");
    const urls = sitemap().map((e) => e.url);
    expect(urls.slice(0, 3)).toEqual([
      "https://www.skywavehf.com/",
      "https://www.skywavehf.com/owners",
      "https://www.skywavehf.com/signals",
    ]);
    for (const s of SIGNAL_STATIONS) expect(urls).toContain(`https://www.skywavehf.com/signals/${s.slug}`);
    expect(urls.every((u) => u.startsWith("https://www.skywavehf.com/"))).toBe(true);
  });
});
