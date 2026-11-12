/**
 * BLOCKED_RECEIVERS: receivers whose owners asked not to be used, as
 * comma-separated host or host:port ([v6]:port for IPv6); a bare host covers
 * every port. The radio service refuses them (same variable on the Droplet);
 * the web app's copy only hides them from the list and map.
 */
export type Blocked = { host: string; port: number | null }[];

export function parseBlocked(raw: string | undefined): Blocked {
  const out: Blocked = [];
  for (const piece of (raw ?? "").split(",")) {
    const item = piece.trim().toLowerCase();
    if (!item) continue;
    let host = item;
    let port: number | null = null;
    const v6 = item.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (v6) {
      host = v6[1]!;
      port = v6[2] ? Number(v6[2]) : null;
    } else if ((item.match(/:/g) ?? []).length === 1) {
      const [h, p] = item.split(":");
      host = h!;
      port = /^\d+$/.test(p!) ? Number(p) : NaN;
    }
    host = host.replace(/\.$/, "");
    // A bad entry is skipped here; the radio service refuses to start on one.
    if (!host || (port !== null && !(port >= 1 && port <= 65_535))) continue;
    out.push({ host, port });
  }
  return out;
}

export function isBlocked(blocked: Blocked, host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return blocked.some((b) => b.host === h && (b.port === null || b.port === port));
}
