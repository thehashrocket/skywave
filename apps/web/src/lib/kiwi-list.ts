import { DEFAULT_KIWI_PORT, parseReceiver } from "./receiver";

/**
 * The public KiwiSDR list, as republished by the dyatlov map maker.
 * kiwisdr.com/public itself sits behind a click-through captcha, so we read
 * this mirror instead. It's a JavaScript file: `var kiwisdr_com = [ {...}, ];`
 */
export const KIWI_LIST_URL = "http://rx.linkfanel.net/kiwisdr_com.js";

export type Receiver = {
  id: string;
  name: string;
  location: string;
  antenna: string;
  host: string;
  port: number;
  users: number;
  usersMax: number;
  /** Self-reported HF signal-to-noise ratio in dB; null when the Kiwi hasn't measured it. */
  snr: number | null;
  /** Tunable range in kHz. Already includes any transverter offset. */
  minKhz: number;
  maxKhz: number;
  /** Listed with an https:// URL, so the radio service dials it over wss://. */
  secure?: true;
};

type RawEntry = Record<string, unknown>;

/** Parse the mirror file into receivers we can actually dial. Throws if it isn't the expected shape. */
export function parseKiwiList(text: string): Receiver[] {
  const seen = new Set<string>();
  const receivers = extractEntries(text).flatMap((json) => {
    // One operator's odd text (a JS-only escape, say) costs only their entry.
    let e: unknown;
    try {
      e = JSON.parse(json);
    } catch {
      return [];
    }
    const r = e && typeof e === "object" ? toReceiver(e as RawEntry) : null;
    // The same receiver listed twice would only collide in the table.
    if (!r || seen.has(receiverKey(r))) return [];
    seen.add(receiverKey(r));
    return [r];
  });
  // An empty result means the format changed under us; better to keep serving
  // the last good list than to replace it with nothing.
  if (receivers.length === 0) throw new Error("Receiver list had no usable receivers.");
  return receivers;
}

/**
 * The objects and arrays in the first top-level array of the file, each as
 * strict JSON: string-aware, so brackets or ", ]" inside an operator's text
 * can't cut one short or get rewritten, and without the trailing commas the
 * generator leaves (JSON.parse rejects them). One pass over the text: the body
 * is untrusted and up to 5 MB.
 */
function extractEntries(text: string): string[] {
  const start = text.indexOf("[");
  if (start < 0) throw new Error("Receiver list has no array in it.");
  const entries: string[] = [];
  let pieces: string[] = [];
  let pieceStart = start;
  let depth = 0;
  let inString = false;
  // A comma outside any string with only whitespace after it so far, which
  // the next closing bracket would make a trailing comma.
  let openComma = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === "]" || c === "}") {
      // Inside an entry; commas between entries don't matter.
      if (depth > 1 && openComma >= 0) {
        pieces.push(text.slice(pieceStart, openComma));
        pieceStart = openComma + 1;
      }
      openComma = -1;
      if (--depth === 1) {
        pieces.push(text.slice(pieceStart, i + 1));
        entries.push(pieces.join(""));
        pieces = [];
      } else if (depth === 0) {
        return entries;
      }
    } else if (c === ",") {
      openComma = i;
    } else if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") {
      openComma = -1;
      if (c === '"') inString = true;
      else if ((c === "[" || c === "{") && ++depth === 2) pieceStart = i;
    }
  }
  throw new Error("Receiver list array never closes.");
}

function toReceiver(e: RawEntry): Receiver | null {
  if (e.status !== "active" || e.offline === "yes") return null;
  const url = text(e.url);
  // parseReceiver passes text it can't parse through as the host; from the
  // list that's junk (a space in the name, an unbracketed IPv6 address).
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) return null;
  // Pick best dials list entries without anyone choosing them, so an entry
  // mustn't aim the radio service at a LAN address or a well-known service
  // port (ssh, smtp, databases). The service also refuses private addresses
  // for list tunes; this keeps such entries out of the list entirely.
  const { host, port: explicitPort, secure } = parseReceiver(url);
  if (!host || isPrivateHost(host)) return null;
  const port = explicitPort ? Number(explicitPort) : defaultPort(host);
  if ((port !== 80 && port < 1024) || SERVICE_PORTS.has(port)) return null;
  const bands = text(e.bands).match(/^(\d+)-(\d+)$/);
  if (!bands) return null;
  const minKhz = Number(bands[1]) / 1000;
  const maxKhz = Number(bands[2]) / 1000;
  // A Kiwi tunes at most 32 MHz wide; a wider claim is made up.
  if (!(minKhz < maxKhz && maxKhz - minKhz <= MAX_SPAN_KHZ)) return null;
  return {
    id: text(e.id) || url,
    name: plain(e.name) || host,
    location: plain(e.loc),
    antenna: plain(e.antenna),
    host,
    port,
    users: int(e.users),
    usersMax: int(e.users_max),
    snr: hfSnr(text(e.snr)),
    minKhz,
    maxKhz,
    ...(secure && { secure: true as const }),
  };
}

// kiwisdr.com's proxy redirects port 80 to 8073; anything else without a
// port in its URL is really listening on 80.
function defaultPort(host: string) {
  return host.endsWith(".proxy.kiwisdr.com") ? DEFAULT_KIWI_PORT : 80;
}

const PRIVATE_NAME = /(^|\.)(localhost|local|lan|internal|home\.arpa)$/i;
const PRIVATE_IPV4 =
  /^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const PRIVATE_IPV6 = /^(::1?|f[cd][0-9a-f]{2}:.*|fe[89ab][0-9a-f]:.*)$/i;

/** Loopback, private-network and local-only names, as an address or a hostname. */
function isPrivateHost(host: string): boolean {
  const name = host.replace(/\.$/, "");
  // URL parsing turns [::ffff:127.0.0.1] into ::ffff:7f00:1; check the IPv4 inside.
  const mapped = name.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  const ipv4 = mapped
    ? [
        parseInt(mapped[1]!, 16) >> 8,
        parseInt(mapped[1]!, 16) & 255,
        parseInt(mapped[2]!, 16) >> 8,
        parseInt(mapped[2]!, 16) & 255,
      ].join(".")
    : name;
  return (
    PRIVATE_NAME.test(name) || PRIVATE_IPV4.test(ipv4) || (!mapped && name.includes(":") && PRIVATE_IPV6.test(name))
  );
}

const MAX_SPAN_KHZ = 32_000;
// Databases, caches, queues and remote-admin services that live above 1024.
// No listed Kiwi uses any of these.
const SERVICE_PORTS = new Set([
  1433, 1521, 2049, 2375, 2376, 3306, 3389, 5432, 5672, 5900, 5984, 6379, 9092, 9200, 9300, 11211, 27017,
]);
// Real Kiwis report HF SNR in the 0-50 dB range. Anything far above that is a
// made-up number that would otherwise win every Pick best, so treat it as
// unmeasured.
const MAX_PLAUSIBLE_SNR = 60;

// "44,42" is all-band then HF; 0 means not measured yet.
function hfSnr(raw: string): number | null {
  const parts = raw.split(",").map(Number);
  const snr = parts[1] ?? parts[0];
  return snr !== undefined && Number.isFinite(snr) && snr > 0 && snr <= MAX_PLAUSIBLE_SNR ? snr : null;
}

/** The mirror sends every field as a string today; accept numbers too in case that changes. */
function text(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

function int(v: unknown): number {
  const n = parseInt(text(v), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Operators put HTML in names and antenna descriptions; show it as plain text. */
function plain(v: unknown): string {
  return (
    text(v)
      // The mirror cuts long fields mid-tag, so a "<a href" with no ">" is a tag too.
      .replace(/<[a-z/!][^>]*(>|$)/gi, "")
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ref: string) => {
        if (ref[0] !== "#") return ENTITIES[ref.toLowerCase()] ?? m;
        const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      })
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function freeSlots(r: Receiver) {
  return Math.max(0, r.usersMax - r.users);
}

export function isFull(r: Receiver) {
  return freeSlots(r) === 0;
}

export function covers(r: Receiver, freqKhz: number) {
  return r.minKhz <= freqKhz && freqKhz <= r.maxKhz;
}

export function receiverKey(r: { host: string; port: number }) {
  return `${r.host}:${r.port}`;
}

/**
 * The best receivers for a frequency, best first: highest HF SNR among those
 * that can tune it. Ones the list calls full go last rather than away, since
 * the list's user counts can be 20 minutes old.
 */
export function rankReceivers(list: readonly Receiver[], freqKhz: number): Receiver[] {
  return list.filter((r) => covers(r, freqKhz)).sort(byRank);
}

/** The ranking order on its own, for sorting a list that isn't filtered by frequency. */
export function byRank(a: Receiver, b: Receiver): number {
  return Number(isFull(a)) - Number(isFull(b)) || (b.snr ?? -1) - (a.snr ?? -1) || freeSlots(b) - freeSlots(a);
}
