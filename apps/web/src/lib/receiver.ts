/**
 * Turn whatever was pasted into the receiver field into a host and port.
 * The public receiver list links to pages like http://f4kiy.ddns.net:8073/,
 * so accept a full URL as well as a bare hostname.
 */
export function parseReceiver(text: string): { host: string; port?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { host: "" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    // URL keeps the brackets on IPv6 literals; the radio service wants them bare.
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    return url.port ? { host, port: url.port } : { host };
  } catch {
    return { host: trimmed };
  }
}
