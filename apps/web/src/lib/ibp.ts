/**
 * The NCDXF/IARU International Beacon Project (issue #59): 18 beacons taking
 * turns on 5 bands, on a fixed schedule, so which one is on the air comes from
 * the clock alone. Pure: every function takes the time it's asked about, which
 * the page reads from the server-corrected clock (server-clock.ts).
 *
 * Source: https://www.ncdxf.org/beacon/beaconlocations.html (order and grid
 * squares, checked 2026-11-18). The schedule page's own script refuses
 * automated fetches, so the order is the locations page's slot column, which
 * matches the issue's list (VE8AT now at Inuvik). Positions are the centres of
 * the listed 6-character grid squares, within about 3 km.
 */

export type Beacon = {
  call: string;
  /** Where it is, as NCDXF names it. */
  location: string;
  /** Maidenhead locator from NCDXF; lat and lon are its centre. */
  grid: string;
  lat: number;
  lon: number;
};

/** In transmission order: the first one opens each cycle on the lowest band. */
export const BEACONS: readonly Beacon[] = [
  { call: "4U1UN", location: "New York", grid: "FN30as", lat: 40.771, lon: -73.958 },
  { call: "VE8AT", location: "Inuvik, NT", grid: "CP38gh", lat: 68.313, lon: -133.458 },
  { call: "W6WX", location: "Mt. Umunhum, CA", grid: "CM97bd", lat: 37.146, lon: -121.875 },
  { call: "KH6RS", location: "Maui", grid: "BL10ts", lat: 20.771, lon: -156.375 },
  { call: "ZL6B", location: "Masterton, NZ", grid: "RE78tw", lat: -41.063, lon: 175.625 },
  { call: "VK6RBP", location: "Rolystone, AU", grid: "OF87av", lat: -32.104, lon: 116.042 },
  { call: "JA2IGY", location: "Mt. Asama, JP", grid: "PM84jk", lat: 34.438, lon: 136.792 },
  { call: "RR9O", location: "Novosibirsk", grid: "NO14kx", lat: 54.979, lon: 82.875 },
  { call: "VR2B", location: "Hong Kong", grid: "OL72bg", lat: 22.271, lon: 114.125 },
  { call: "4S7B", location: "Colombo", grid: "MJ96wv", lat: 6.896, lon: 79.875 },
  { call: "ZS6DN", location: "Pretoria", grid: "KG33xi", lat: -26.646, lon: 27.958 },
  { call: "5Z4B", location: "Kikuyu, KE", grid: "KI88hr", lat: -1.271, lon: 36.625 },
  { call: "4X6TU", location: "Tel Aviv", grid: "KM72jb", lat: 32.063, lon: 34.792 },
  { call: "OH2B", location: "Lohja, FI", grid: "KP20eh", lat: 60.313, lon: 24.375 },
  { call: "CS3B", location: "Madeira", grid: "IM12jt", lat: 32.813, lon: -17.208 },
  { call: "LU4AA", location: "Buenos Aires", grid: "GF05tj", lat: -34.604, lon: -58.375 },
  { call: "OA4B", location: "Lima", grid: "FH17mw", lat: -12.063, lon: -76.958 },
  { call: "YV5B", location: "Caracas", grid: "FK60nd", lat: 10.146, lon: -66.875 },
];

/** The five beacon frequencies, lowest first: a beacon steps up through them, one per slot. */
export const IBP_BANDS_KHZ = [14_100, 18_110, 21_150, 24_930, 28_200] as const;

/** Each beacon transmits for this long on a band, then steps up to the next. */
export const SLOT_MS = 10_000;

/**
 * One pass of every beacon over every band: 18 slots of 10 s. A day is 480
 * cycles exactly, so cycles line up with 00:00:00 UTC (and with the Unix
 * epoch, which ignores leap seconds as the beacons' GPS-UTC clocks do).
 */
export const CYCLE_MS = BEACONS.length * SLOT_MS;

/**
 * How far from a beacon frequency the dial can sit and still count as tuned
 * to it: half the CW passband (radio-types PASSBANDS, 450–950 Hz around a
 * 700 Hz pitch), so the carrier is inside what the listener hears.
 */
export const IBP_TOLERANCE_KHZ = 0.25;

/** A modulo that stays positive for times before the epoch. */
const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Which 10 s slot of the 3-minute cycle `ms` (Unix time) falls in: 0..17. */
export function slotAt(ms: number): number {
  return Math.floor(mod(ms, CYCLE_MS) / SLOT_MS);
}

/** The beacon transmitting on band `bandIndex` (into IBP_BANDS_KHZ) at `ms`. */
export function beaconOnBand(ms: number, bandIndex: number): Beacon {
  const n = BEACONS.length;
  return BEACONS[mod(slotAt(ms) - bandIndex, n)]!;
}

/** How long until the beacons next change bands, in ms: 1..SLOT_MS. */
export function msLeftInSlot(ms: number): number {
  return SLOT_MS - mod(ms, SLOT_MS);
}

/** The start of the slot `ms` falls in. */
export function slotStart(ms: number): number {
  return ms - mod(ms, SLOT_MS);
}

/** Which band a dial frequency is a beacon frequency for, or -1 for none. */
export function ibpBandIndex(freqKhz: number): number {
  return IBP_BANDS_KHZ.findIndex((khz) => Math.abs(freqKhz - khz) <= IBP_TOLERANCE_KHZ);
}

/** The beacon with this callsign, if it's one of the 18. */
export function findBeacon(call: string): Beacon | undefined {
  return BEACONS.find((b) => b.call === call);
}

/**
 * Every beacon that was on band `bandIndex` at some point in [fromMs, toMs],
 * oldest first: each slot touching the interval counts, partly or wholly.
 */
export function beaconsBetween(bandIndex: number, fromMs: number, toMs: number): Beacon[] {
  const out: Beacon[] = [];
  for (let t = slotStart(fromMs); t <= toMs; t += SLOT_MS) {
    const b = beaconOnBand(t, bandIndex);
    if (!out.includes(b)) out.push(b);
    if (out.length === BEACONS.length) break;
  }
  return out;
}
