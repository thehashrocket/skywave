/** The port KiwiSDRs listen on unless their owner changed it. */
export const DEFAULT_KIWI_PORT = 8073;

/** Where an https:// receiver listens when its URL names no port. */
export const HTTPS_PORT = 443;

/**
 * Turn whatever was pasted into the receiver field into a host and port.
 * The public receiver list links to pages like http://f4kiy.ddns.net:8073/,
 * so accept a full URL as well as a bare hostname.
 *
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
    const port = url.port || (secure ? String(HTTPS_PORT) : undefined);
    return port ? { host, port, secure } : { host, secure };
  } catch {
    return { host: trimmed };
  }
}
