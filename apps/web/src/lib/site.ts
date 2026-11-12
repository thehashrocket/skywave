/**
 * Whether this deployment is open to everyone (NEXT_PUBLIC_SITE_PUBLIC=1).
 * Then the shared presets are read-only picks, and each browser keeps its own
 * saved frequencies. Read at build time on the client, at run time on the server.
 */
export function sitePublic(): boolean {
  return process.env.NEXT_PUBLIC_SITE_PUBLIC === "1";
}
