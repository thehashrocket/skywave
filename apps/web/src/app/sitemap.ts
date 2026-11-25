import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-url";
import { SIGNAL_STATIONS } from "@/lib/signal-stations";

/**
 * The pages search engines should find (#103): the main page, the owners
 * page, the signal stations index and each station's page, all on the site's
 * own address (siteUrl), never one that redirects.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const at = (path: string) => new URL(path, base).toString();
  return [
    { url: at("/"), changeFrequency: "weekly", priority: 1 },
    { url: at("/owners"), changeFrequency: "monthly", priority: 0.3 },
    { url: at("/signals"), changeFrequency: "weekly", priority: 0.8 },
    ...SIGNAL_STATIONS.map((s) => ({
      url: at(`/signals/${s.slug}`),
      changeFrequency: "weekly" as const,
      priority: s.schedule.kind === "defunct" ? 0.4 : 0.7,
    })),
  ];
}
