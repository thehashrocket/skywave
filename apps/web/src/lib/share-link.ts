import { inTuneRange, isMode, type Mode } from "@/lib/radio-types";
import { formatHostPort, parseReceiver } from "@/lib/receiver";

/**
 * Links that open skywave tuned somewhere: `?f=9580&m=am`, plus
 * `&rx=host:port` (and `&tls=1` for an https-only receiver) to name the
 * receiver. Without rx, Listen picks the best receiver for the frequency.
 * A link never starts audio: browsers only allow that after a click.
 */
export type SharedTuning = {
  freqKhz?: number;
  mode?: Mode;
  receiver?: { host: string; port: number; secure: boolean };
};

// Longer than any DNS name: refused rather than shown or dialed.
const HOST_MAX = 253;

/** What a link's query string asks for, or null if it asks for nothing usable. */
export function parseShareLink(search: string): SharedTuning | null {
  const q = new URLSearchParams(search);
  const out: SharedTuning = {};
  const f = q.get("f");
  if (f !== null && /^\d+(\.\d+)?$/.test(f.trim())) {
    // To the dial's 10 Hz steps.
    const khz = Math.round(Number(f) * 100) / 100;
    if (inTuneRange(khz)) out.freqKhz = khz;
  }
  const m = q.get("m")?.trim().toLowerCase();
  if (isMode(m)) out.mode = m;
  const rx = q.get("rx");
  if (rx) {
    const secure = q.get("tls") === "1";
    const parsed = parseReceiver(rx);
    const port = Number(parsed.port ?? "8073");
    if (
      parsed.host &&
      parsed.host.length <= HOST_MAX &&
      /^[a-z0-9.:-]+$/i.test(parsed.host) &&
      // A colon belongs only in an IPv6 address: "host:70000" is a bad port, not a host.
      (!parsed.host.includes(":") || parsed.host.split(":").length > 2) &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65_535
    ) {
      out.receiver = { host: parsed.host.toLowerCase(), port, secure };
    }
  }
  return out.freqKhz === undefined && out.mode === undefined && !out.receiver ? null : out;
}

/** A link to `base` (origin and path) that opens tuned like this. */
export function buildShareLink(
  base: string,
  t: { freqKhz: number; mode: Mode; receiver?: { host: string; port: number; secure: boolean } | null },
): string {
  const q = new URLSearchParams();
  q.set("f", String(Math.round(t.freqKhz * 100) / 100));
  q.set("m", t.mode);
  if (t.receiver?.host) {
    q.set("rx", formatHostPort(t.receiver.host, t.receiver.port));
    if (t.receiver.secure) q.set("tls", "1");
  }
  return `${base}?${q.toString()}`;
}
