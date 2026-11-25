/**
 * The site's own address, for absolute links (link previews, the sitemap).
 * Vercel sets VERCEL_PROJECT_PRODUCTION_URL to the production domain, which is
 * www.skywavehf.com (the bare skywavehf.com redirects there), so every page
 * declares the address search engines index instead of a redirect (#103).
 * Locally it's the dev server.
 */
export function siteUrl(): URL {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return new URL(host ? `https://${host}` : "http://localhost:3000");
}
