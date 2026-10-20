/** The port KiwiSDRs listen on unless their owner changed it. */
export const DEFAULT_KIWI_PORT = 8073;

/** Where an https:// receiver listens when its URL names no port. */
export const HTTPS_PORT = 443;

/**
 * The port a receiver URL means when it names none. kiwisdr.com's proxy
 * redirects port 80 to 8073; any other http:// URL without a port really is
 * on 80, and https:// on 443.
 */
export function defaultPort(host: string, secure: boolean): number {
  if (secure) return HTTPS_PORT;
  return host.replace(/\.$/, "").endsWith(".proxy.kiwisdr.com") ? DEFAULT_KIWI_PORT : 80;
}

/**
 * Turn whatever was pasted into the receiver field into a host and port.
 * The public receiver list links to pages like http://f4kiy.ddns.net:8073/,
 * so accept a full URL as well as a bare hostname.
 *
 * A URL with a scheme always yields a port, defaulted the way the public list
 * does. A bare hostname has none, so the port field keeps what it had.
 * `secure` is set only when the text names a scheme: true for https:// (or
 * wss://), which the radio service dials over wss://, false for http://.
 */
export function parseReceiver(text: string): { host: string; port?: string; secure?: boolean } {
  const trimmed = text.trim();
  if (!trimmed) return { host: "" };
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  try {
    const url = new URL(scheme ? trimmed : `http://${trimmed}`);
    // URL keeps the brackets on IPv6 literals; the radio service wants them bare.
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (!scheme) return url.port ? { host, port: url.port } : { host };
    const secure = scheme === "https" || scheme === "wss";
    // URL drops a scheme's default port, even one typed out like :443.
    return { host, port: url.port || String(defaultPort(host, secure)), secure };
  } catch {
    return { host: trimmed };
  }
}

/** host:port for display, with an IPv6 host bracketed so it pastes back as an address. */
export function formatHostPort(host: string, port: number | string): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}
