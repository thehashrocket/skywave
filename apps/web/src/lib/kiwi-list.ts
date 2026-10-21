import { defaultPort, HTTPS_PORT, parseReceiver } from "./receiver";

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

/**
 * More than three times the real list. Past this, "Show all" would freeze
 * the tab; rows beyond it are dropped in the mirror's order, before ranking.
 */
export const MAX_ROWS = 3000;
/** Operators' names, places and antennas are cut to this many characters. */
export const MAX_FIELD = 200;

/** Parse the mirror file into receivers we can actually dial. Throws if it isn't the expected shape. */
export function parseKiwiList(text: string): Receiver[] {
  const seen = new Set<string>();
  const receivers: Receiver[] = [];
  for (const json of extractEntries(text)) {
    if (receivers.length >= MAX_ROWS) break;
    // One operator's odd text (a JS-only escape, say) costs only their entry.
    let e: unknown;
    try {
      e = JSON.parse(json);
    } catch {
      continue;
    }
    const r = e && typeof e === "object" ? toReceiver(e as RawEntry) : null;
    // The same receiver listed twice would only collide in the table.
    if (!r || seen.has(receiverKey(r))) continue;
    seen.add(receiverKey(r));
    receivers.push(r);
  }
  // An empty result means the format changed under us; better to keep serving
  // the last good list than to replace it with nothing.
  if (receivers.length === 0) throw new Error("Receiver list had no usable receivers.");
  return receivers;
}

/**
 * The objects and arrays in the file's `kiwisdr_com = [...]` array, each as
 * strict JSON: string-aware, so brackets or ", ]" inside an operator's text
 * can't cut one short or get rewritten, and without the trailing commas the
 * generator leaves (JSON.parse rejects them). One pass over the text: the body
 * is untrusted and up to 5 MB.
 */
function extractEntries(text: string): string[] {
  // Anchored on the variable, so a bracket in a comment or a new wrapper line
  // above it can't be read as the list.
  const anchor = /\bkiwisdr_com\s*=\s*\[/.exec(text);
  if (!anchor) throw new Error("Receiver list has no array in it.");
  const start = anchor.index + anchor[0].length - 1;
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
  // ext_api is how many connections the owner allows from anything but the
  // Kiwi's own web page. At 0, it plays to us for about 10 s, then sends
  // too_busy=0 and hangs up (probed 2026-10-21). A missing field stays listed.
  if (text(e.ext_api).trim() === "0") return null;
  const url = text(e.url);
  // parseReceiver passes text it can't parse through as the host; from the
  // list that's junk (a space in the name, an unbracketed IPv6 address).
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) return null;
  // The service dials host and port only; a receiver behind a path (a reverse
  // proxy at /kiwi/) would get a request it can't answer.
  if (!/^[a-z]+:\/\/[^/?#]+\/?([?#]|$)/i.test(url)) return null;
  // Pick best dials list entries without anyone choosing them, so an entry
  // mustn't aim the radio service at a LAN address or at anything but a Kiwi
  // port. The service also refuses private addresses for list tunes; this
  // keeps such entries out of the list entirely.
  const { host: dotted, port: urlPort, secure = false } = parseReceiver(url);
  // "kiwi.example." is the same name, but the service's hostname check refuses the dot.
  const host = dotted.replace(/\.$/, "");
  if (!host || isPrivateHost(host)) return null;
  const port = Number(urlPort ?? defaultPort(host, secure));
  if (!isKiwiPort(port, secure)) return null;
  const bands = text(e.bands).match(/^(\d+)-(\d+)$/);
  if (!bands) return null;
  const minKhz = Number(bands[1]) / 1000;
  const maxKhz = Number(bands[2]) / 1000;
  // A Kiwi tunes at most 32 MHz wide; a wider claim is made up.
  if (!(minKhz < maxKhz && maxKhz - minKhz <= MAX_SPAN_KHZ)) return null;
  return {
    id: text(e.id).slice(0, MAX_FIELD) || url,
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

/**
 * Ports a list entry may point at: 80 (kiwisdr.com's proxy and plain hosts)
 * and 8070-8079, where Kiwis listen; 443 too for an https:// entry. That's
 * 850 of 873 entries (2026-10-20); the rest would let a hostile entry aim the
 * service at ordinary web and admin ports (8080, 8443, 5000). Typed
 * receivers can use any port.
 */
function isKiwiPort(port: number, secure: boolean): boolean {
  return port === 80 || (port >= 8070 && port <= 8079) || (secure && port === HTTPS_PORT);
}

const PRIVATE_NAME = /(^|\.)(localhost|local|lan|internal|home\.arpa)$/i;

/**
 * IPv4 ranges that aren't the public internet, as [first octets, prefix
 * bits]: private, loopback, link-local, carrier NAT, documentation and
 * benchmarking nets, multicast and reserved. The radio service refuses all
 * of these for list tunes anyway (Python's is_global).
 */
const NON_PUBLIC_IPV4: [number[], number][] = [
  [[0], 8],
  [[10], 8],
  [[100, 64], 10],
  [[127], 8],
  [[169, 254], 16],
  [[172, 16], 12],
  [[192, 0, 0], 24],
  [[192, 0, 2], 24],
  [[192, 168], 16],
  [[198, 18], 15],
  [[198, 51, 100], 24],
  [[203, 0, 113], 24],
  [[224], 4], // multicast
  [[240], 4], // reserved, and 255.255.255.255
];

function ipv4Number(octets: number[]): number {
  return octets.reduce((n, o) => n * 256 + o, 0);
}

function isNonPublicIpv4(address: string): boolean {
  const m = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const ip = ipv4Number(m.slice(1).map(Number));
  return NON_PUBLIC_IPV4.some(([start, bits]) => {
    const base = ipv4Number([...start, 0, 0, 0, 0].slice(0, 4));
    const size = 2 ** (32 - bits);
    return ip >= base && ip < base + size;
  });
}

/**
 * IPv6 prefixes that aren't the public internet, as URL writes them
 * (lowercase, compressed): loopback and unspecified, unique-local,
 * link-local, multicast, documentation, discard, 6to4 and NAT64 (which wrap
 * an IPv4 address we'd otherwise have to unpack), and IPv4-compatible.
 */
const NON_PUBLIC_IPV6 = /^(::1?|f[cd][0-9a-f]{2}:.*|fe[89ab][0-9a-f]:.*|ff[0-9a-f]{2}:.*|2001:db8:.*|100::.*|2002:.*|64:ff9b:.*|::[0-9a-f]{1,4}:[0-9a-f]{1,4})$/i;

/** Loopback, private-network and local-only names, as an address or a hostname. */
function isPrivateHost(name: string): boolean {
  // URL parsing turns [::ffff:127.0.0.1] into ::ffff:7f00:1; check the IPv4 inside.
  const mapped = name.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)];
    return isNonPublicIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."));
  }
  return PRIVATE_NAME.test(name) || isNonPublicIpv4(name) || (name.includes(":") && NON_PUBLIC_IPV6.test(name));
}

const MAX_SPAN_KHZ = 32_000;
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
      .slice(0, MAX_FIELD * 4) // room for markup the next lines strip
      // The mirror cuts long fields mid-tag, so a "<a href" with no ">" is a tag too.
      .replace(/<[a-z/!][^>]*(>|$)/gi, "")
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ref: string) => {
        if (ref[0] !== "#") return ENTITIES[ref.toLowerCase()] ?? m;
        const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      })
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_FIELD)
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

// Fixed for the page's lifetime, so the table doesn't reshuffle on every
// refetch, but different for each listener.
const TIE_SEED = Math.floor(Math.random() * 2 ** 32);

/** A per-page-load shuffle key, FNV-1a over the receiver's address. */
function tieBreak(r: Receiver): number {
  let h = 0x811c9dc5 ^ TIE_SEED;
  for (const c of receiverKey(r)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return h >>> 0;
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
  return (
    Number(isFull(a)) - Number(isFull(b)) ||
    (b.snr ?? -1) - (a.snr ?? -1) ||
    freeSlots(b) - freeSlots(a) ||
    // Not the mirror's order: every listener would converge on the same receiver.
    tieBreak(a) - tieBreak(b)
  );
}
