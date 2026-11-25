import { z } from "zod";
import { MATCH_KHZ, onAirBetween, scheduledOn, type Broadcast, type ListedBroadcast } from "@/lib/eibi";
import { byKey, candidateFor, type SiteCandidate, type SiteTable } from "@/lib/eibi-sites";
import { isBroadRegion } from "@/lib/eibi-targets";
import { beaconOnBand, ibpBandIndex, SLOT_MS } from "@/lib/ibp";
import { findReceiver, MAX_PLAUSIBLE_SNR, MAX_ROWS, type Receiver } from "@/lib/kiwi-list";
import { MAX_CANDIDATES, MAX_USERS, PICK_CONTEXT_VERSION, PICK_SOURCES, pickKey } from "@/lib/pick-context";
import { PRIYOM_ON_AIR_MS, type PriyomTx } from "@/lib/priyom-schedule";
import { MODES } from "@/lib/radio-types";
import {
  ASK_RULE_VERSION,
  BEACON_MIN_HEARD_MS,
  COMMENT_MAX,
  LISTING_GRACE_MS,
  MAX_LISTED,
  OUTCOMES,
  SAME_CHANNEL_MS,
  signalAsk,
  STREAM_LATENCY_MS,
  TX_KINDS,
  TX_NAME_SEPARATOR,
} from "@/lib/reception";
import { onKhz } from "@/lib/signal-panel";
import { findStation } from "@/lib/signal-stations";
import { publicProcedure, router } from "../trpc";
import { getBeaconStatus, rbnDays } from "./beacons";
import { getReceivers, servedReceivers } from "./receivers";
import { getPriyomSchedule } from "./signals";
import { getSchedule, getSites } from "./stations";

const MINUTE = 60_000;

/**
 * Whether every station in txName ("A", or "A / B / C") was scheduled on this
 * frequency at some minute in the last LISTING_GRACE_MS, by this server's
 * clock. The schedule works in whole minutes, so each minute is checked.
 */
export function scheduledRecently(schedule: readonly Broadcast[], txName: string, freqKhz: number, ms: number) {
  const names = txName.split(TX_NAME_SEPARATOR);
  if (names.length > MAX_LISTED) return false;
  const onAir = new Set<string>();
  for (let t = ms - LISTING_GRACE_MS; t <= ms; t += MINUTE) {
    for (const b of scheduledOn(schedule, freqKhz, t)) onAir.add(b.station);
  }
  return names.every((n) => onAir.has(n));
}

/**
 * The transmitters an EiBi answer could have been about (#72 eng review,
 * D8/D10/D12): for each station in txName, every listing on this frequency
 * (within MATCH_KHZ, any language, every site) at the latest minute of the
 * last LISTING_GRACE_MS it was on the air, so a changeover at :00 or :30
 * doesn't add the outgoing slot's site. One candidate per distinct site,
 * sorted for a stable row.
 */
export function sitesHeard(
  schedule: readonly ListedBroadcast[],
  sites: SiteTable,
  txName: string,
  freqKhz: number,
  ms: number,
): SiteCandidate[] {
  const names = txName.split(TX_NAME_SEPARATOR);
  const latest = new Map<string, ListedBroadcast[]>();
  for (let t = ms - LISTING_GRACE_MS; t <= ms; t += MINUTE) {
    const onAir = onAirBetween(schedule, freqKhz - MATCH_KHZ, freqKhz + MATCH_KHZ, t);
    for (const name of names) {
      const rows = onAir.filter((b) => b.station === name);
      if (rows.length > 0) latest.set(name, rows);
    }
  }
  const out = new Map<string, SiteCandidate>();
  for (const b of [...latest.values()].flat()) {
    const c = candidateFor(sites, b.site, b.country);
    out.set(c.key ?? `?${c.country}`, c);
  }
  return [...out].sort(byKey).map(([, c]) => c);
}

/**
 * How far ahead of this server's clock a slot may start: the page corrects
 * its clock from a Date header to about a second, and asks only after a slot
 * has ended, so more than this is a made-up slot.
 */
export const MAX_CLOCK_SKEW_MS = 5_000;

/**
 * Whether the page's report names the beacon that really was on the air:
 * `slotStartMs` starts a 10 s slot, within the last LISTING_GRACE_MS by this
 * server's clock (and no more than MAX_CLOCK_SKEW_MS ahead of it), and the
 * schedule has `call` on the band `freqKhz` is tuned to in that slot. The
 * page asks once the slot's end reaches the listener and closes the prompt
 * well before the slot leaves this window.
 */
export function beaconSlotChecks(call: string, freqKhz: number, slotStartMs: number, ms: number) {
  const band = ibpBandIndex(freqKhz);
  return (
    band >= 0 &&
    slotStartMs % SLOT_MS === 0 &&
    slotStartMs >= ms - LISTING_GRACE_MS &&
    slotStartMs <= ms + MAX_CLOCK_SKEW_MS &&
    beaconOnBand(slotStartMs, band).call === call
  );
}

/**
 * Whether a signal-station report (#101) names a station that really was on
 * the air on `freqKhz`, by this server's clock: a catalog station that isn't
 * defunct, on a channel it was on at some minute in the last LISTING_GRACE_MS
 * (either of a day/night station's, as the page allows). A numbers station's
 * times come from Priyom: `slotStartMs` must be the start of one of its
 * transmissions on that frequency in this server's copy of the schedule
 * (`priyom`, null when it has none: then nothing can be vouched for), started
 * no more than MAX_CLOCK_SKEW_MS ahead and on the air (PRIYOM_ON_AIR_MS)
 * within the last LISTING_GRACE_MS.
 */
export function signalChecks(
  slug: string,
  freqKhz: number,
  slotStartMs: number | undefined,
  priyom: readonly PriyomTx[] | null,
  ms: number,
): boolean {
  const station = findStation(slug);
  if (!station) return false;
  if (station.priyom) {
    if (slotStartMs === undefined || !priyom) return false;
    const slot = priyom.some(
      (t) => t.station === station.priyom && t.startMs === slotStartMs && t.khz !== null && onKhz(freqKhz, t.khz),
    );
    return (
      slot && slotStartMs <= ms + MAX_CLOCK_SKEW_MS && slotStartMs + PRIYOM_ON_AIR_MS >= ms - LISTING_GRACE_MS
    );
  }
  for (let t = ms - LISTING_GRACE_MS; t <= ms; t += MINUTE) if (signalAsk(station, freqKhz, null, t)) return true;
  return false;
}

/** The public list as the page is served it (opted-out owners left out), or null with none to check against. */
async function servedList(): Promise<readonly Receiver[] | null> {
  try {
    return servedReceivers((await getReceivers()).receivers);
  } catch {
    // The mirror is down on a fresh server: can't vouch for any receiver.
    return null;
  }
}

/**
 * How many of a context's candidates are on the public list now. A forged key
 * can't be; a real receiver that left the list since the pick (up to 3 hours
 * ago) isn't either, so the context is kept and the replay decides.
 */
export function listedCandidates(candidates: readonly string[], served: readonly Receiver[]): number {
  const keys = new Set(served.map(pickKey));
  return candidates.filter((k) => keys.has(k)).length;
}

/** Reports one listener may send in a rolling hour. */
export const REPORTS_PER_HOUR = 10;

export { SAME_CHANNEL_MS };

/**
 * Reports about one receiver in a rolling hour, from everyone. The listener
 * id is made by the browser, so a script can send a fresh one with every
 * report and never meet the per-listener limits; this cap bounds what such
 * a flood can add to any one receiver's data (issue #60's "cap per receiver
 * per hour"). A real hour seldom sees more than a handful. The cost: a flood
 * also crowds out genuine reports for that receiver until the hour rolls.
 */
export const RECEIVER_REPORTS_PER_HOUR = 30;

/**
 * How old a pick may be: a listening session lasts at most an hour on the
 * radio service, so anything much older is a page bug or made up.
 */
export const MAX_PICK_AGE_MS = 3 * 60 * MINUTE;

/** The longest key pickKey writes: a 253-character hostname, a colon, a 5-digit port. */
const MAX_CANDIDATE_KEY = 253 + 1 + 5;

/**
 * Whether a candidate is a receiver key exactly as pickKey writes it, so two
 * spellings of one receiver can't pass as two: a lowercase hostname or IPv4
 * address (at most 253 characters, no trailing dot) or a bare IPv6 address in
 * its compressed form (parseReceiver drops the brackets), a colon, then a
 * port from 1 to 65535 with no leading zero. A URL round trip is the
 * canonical form, as it is for the list's own hosts. Every key the page
 * writes passes, so one that doesn't comes from a broken or forged page, and
 * the whole context goes: dropping just that key would shift the list under
 * rankPos.
 */
export function candidateKeyOk(key: string): boolean {
  // Before any parsing: a forged key of any length mustn't cost a regex and a URL parse.
  if (key.length > MAX_CANDIDATE_KEY) return false;
  const m = key.match(/^(.+):([1-9][0-9]{0,4})$/);
  if (!m || Number(m[2]) > 65_535) return false;
  const host = m[1]!;
  const ipv6 = host.includes(":");
  if (!ipv6 && !/^(?=.{1,253}$)[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(host)) return false;
  const bracketed = ipv6 ? `[${host}]` : host;
  try {
    return new URL(`http://${bracketed}/`).hostname === bracketed;
  } catch {
    return false;
  }
}

/**
 * How Pick best chose the receiver (issue #61, lib/pick-context.ts). The page
 * can't be vouched for, so this is checked, and bad context costs only
 * itself: owner decision D6 keeps the answer, which is the scarce part. The
 * values themselves (position, SNR, users) can't be checked against the list
 * as it was at pick time; only their shape and ranges are.
 */
const pickInput = z
  .object({
    // Absent from pages built before PICK_CONTEXT_VERSION existed (stored as null).
    version: z.number().int().min(2).max(PICK_CONTEXT_VERSION).optional(),
    pickedAtMs: z.number().int().positive(),
    pickSource: z.enum(PICK_SOURCES),
    // A place in a list of at most MAX_ROWS receivers, from 0.
    rankPos: z.number().int().min(0).max(MAX_ROWS - 1),
    candidates: z
      .array(z.string().refine(candidateKeyOk, "not a receiver key"))
      .min(1)
      .max(MAX_CANDIDATES)
      .refine((keys) => new Set(keys).size === keys.length, "duplicate candidate"),
    freqKhz: z.number().positive().max(32_000),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    snr: z.number().min(0).max(MAX_PLAUSIBLE_SNR).nullable(),
    users: z.number().int().min(0).max(MAX_USERS),
  })
  // pickContext keeps a position only when both halves are known.
  .refine((p) => (p.lat === undefined) === (p.lon === undefined), { path: ["lat"], message: "lat without lon" });
type PickInput = z.infer<typeof pickInput>;

/**
 * The latest a pick can come in a beacon slot that's then asked about. The
 * page asks about a slot only if BEACON_MIN_HEARD_MS of it played after first
 * audio plus STREAM_LATENCY_MS (heardEnough), and the pick precedes the audio:
 * so a pick at or after slot start + SLOT_MS - BEACON_MIN_HEARD_MS -
 * STREAM_LATENCY_MS can't be the one that led to it. Both times are the page's
 * serverNow(), so its clock error cancels.
 */
export const PICK_IN_SLOT_MS = SLOT_MS - BEACON_MIN_HEARD_MS - STREAM_LATENCY_MS;

/**
 * Whether a well-formed pick fits the report it came with: ranked for the
 * frequency answered about, made before the beacon slot asked about could
 * still be heard (and not in the future or long ago, by this server's clock),
 * naming the answered receiver at its rank when that's among the candidates,
 * and from the button that can lead to this kind of question: the page asks
 * about a beacon only after beacon Listen chose the receiver (any other run
 * clears that choice first), and beacon Listen leads to no other question.
 * A signal-station question (#101) follows only a signal Listen; that Listen
 * can still lead to a station question, when the dial is moved back onto the
 * frequency by hand after the pick has ended.
 */
export function pickChecks(
  pick: PickInput,
  report: { receiverHost: string; receiverPort: number; freqKhz: number; txKind: string; slotStartMs?: number },
  ms: number,
): boolean {
  const { rankPos, candidates, pickedAtMs } = pick;
  const key = pickKey({ host: report.receiverHost, port: report.receiverPort });
  const named =
    rankPos < candidates.length
      ? candidates[rankPos] === key
      : // Past the stored head: the list was longer than it, and the receiver isn't in it.
        candidates.length === MAX_CANDIDATES && !candidates.includes(key);
  return (
    named &&
    pick.freqKhz === report.freqKhz &&
    (pick.pickSource === "beacon") === (report.txKind === "beacon") &&
    (report.txKind !== "signal" || pick.pickSource === "signal") &&
    pickedAtMs <= ms + MAX_CLOCK_SKEW_MS &&
    pickedAtMs >= ms - MAX_PICK_AGE_MS &&
    // Beacon Listen picks the beacon on the air, so the slot asked about can be
    // the one that was already on when it picked.
    (report.slotStartMs === undefined || pickedAtMs < report.slotStartMs + PICK_IN_SLOT_MS)
  );
}

/** Blank text is no text. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((s) => s || undefined);

/**
 * An optional marker the page sends with an answer: a bad value is dropped
 * (and logged) rather than failing the whole report, as malformed pick
 * context is.
 */
const droppable = <T extends z.ZodType>(name: string, schema: T) =>
  // Logs the kind of value only: the input is untrusted, and superjson can deliver
  // values (a BigInt) that JSON.stringify would throw on, failing the whole report.
  schema.optional().catch(({ input }) => {
    console.warn(`reports.submit: dropped malformed ${name} (${typeof input})`);
    return undefined;
  });

const reportInput = z.object({
  listenerId: z.uuid(),
  // Lowercase, as receiverKey compares them, so one receiver isn't two in the data.
  receiverHost: z.string().trim().toLowerCase().min(1).max(253),
  receiverPort: z.number().int().min(1).max(65_535),
  freqKhz: z.number().positive().max(32_000),
  mode: z.enum(MODES),
  // An EiBi listing, an IBP beacon (#59) by callsign, or a signal station (#101) by slug; the column is text.
  txKind: z.enum(TX_KINDS),
  txName: z.string().trim().min(1).max(200),
  txDetail: optionalText(100),
  // Beacons: the UTC start of the 10 s slot asked about (beaconSlotChecks).
  // Numbers stations: the start of Priyom's transmission asked about (signalChecks).
  slotStartMs: z.number().int().optional(),
  // EiBi answers: which rules chose the station asked about and the region they ranked
  // by (#115; lib/reception.ts ASK_RULE_VERSION). The page's word; kept for EiBi rows only.
  askRule: droppable("askRule", z.number().int().min(1).max(ASK_RULE_VERSION)),
  askRegion: droppable("askRegion", z.string().refine(isBroadRegion)),
  outcome: z.enum(OUTCOMES),
  comment: optionalText(COMMENT_MAX),
  // Malformed context is dropped here rather than failing the whole report.
  pick: pickInput.optional().catch(({ error }) => {
    console.warn(
      "reports.submit: dropped malformed pick context:",
      error.issues.map((i) => i.path.join(".") || "(root)").join(", "),
    );
    return undefined;
  }),
});

export type ReportInput = z.input<typeof reportInput>;

export const reportsRouter = router({
  /**
   * Store one reception report. Over a limit, or about a receiver or station
   * the server can't vouch for, it answers { accepted: false } rather than an
   * error: the listener has nothing to fix, so nothing to show.
   *
   * The limits are counted in the database, not memory: Vercel's function
   * instances don't share memory. Two reports racing past the count can both
   * land; at these limits that's harmless. Per-listener limits only hold for
   * honest clients (the id is the browser's own); RECEIVER_REPORTS_PER_HOUR
   * is the one a script can't sidestep, and a per-IP rate limit belongs in
   * Vercel's firewall, since nothing here sees or stores addresses.
   */
  submit: publicProcedure.input(reportInput).mutation(async ({ ctx, input }) => {
    const now = Date.now();
    const { listenerId, receiverHost, receiverPort, freqKhz } = input;
    // Only what the page could really have asked about: a listed receiver,
    // and a station the schedule had on that frequency just now (or the
    // beacon the schedule had on that band in the slot asked about, or the signal
    // station on the air there). From this server's cached copies; none fetches per
    // request, except Priyom's on a server that has no copy yet.
    const { slotStartMs, pick, askRule, askRegion, ...report } = input;
    let listed: readonly ListedBroadcast[] | undefined;
    // The slot kept with the answer: a beacon's, or a numbers station's Priyom transmission.
    let slot: number | undefined;
    if (input.txKind === "beacon") {
      if (slotStartMs === undefined || !beaconSlotChecks(input.txName, freqKhz, slotStartMs, now))
        return { accepted: false };
      slot = slotStartMs;
    } else if (input.txKind === "signal") {
      const priyomStation = findStation(input.txName)?.priyom !== undefined;
      const priyom = priyomStation ? ((await getPriyomSchedule())?.transmissions ?? null) : null;
      if (!signalChecks(input.txName, freqKhz, slotStartMs, priyom, now)) return { accepted: false };
      if (priyomStation) slot = slotStartMs;
    } else {
      ({ listed } = await getSchedule());
      if (!scheduledRecently(listed, input.txName, freqKhz, now)) return { accepted: false };
    }
    const served = await servedList();
    if (!served || !findReceiver(served, receiverHost, receiverPort)) return { accepted: false };
    const hourAgo = new Date(now - 60 * MINUTE);
    const [lastHour, receiverHour, sameChannel] = await Promise.all([
      ctx.db.receptionReport.count({ where: { listenerId, createdAt: { gte: hourAgo } } }),
      ctx.db.receptionReport.count({ where: { receiverHost, receiverPort, createdAt: { gte: hourAgo } } }),
      ctx.db.receptionReport.count({
        where: {
          listenerId,
          receiverHost,
          receiverPort,
          freqKhz,
          // Each kind counts only its own answers, so an answer about a signal station
          // after a Listen doesn't block the EiBi question about that frequency later
          // (the page asks it), nor the other way round. A beacon frequency carries a
          // new beacon every 10 s: each callsign is its own channel. Signal stations
          // share frequencies too (WWV and WWVH): each is its own.
          txKind: input.txKind,
          ...(input.txKind !== "eibi" && { txName: input.txName }),
          createdAt: { gte: new Date(now - SAME_CHANNEL_MS) },
        },
      }),
    ]);
    if (lastHour >= REPORTS_PER_HOUR || receiverHour >= RECEIVER_REPORTS_PER_HOUR || sameChannel > 0)
      return { accepted: false };
    // NCDXF's word on the beacon now, from this server's cached copy (null until it has one).
    const official =
      input.txKind === "beacon" ? (await getBeaconStatus())?.beacons.find((b) => b.call === input.txName) : undefined;
    // RBN's count for the last day this server has saved (never downloads here).
    const rbnDay = input.txKind === "beacon" ? await rbnDays.peek() : null;
    const rbn = rbnDay?.beacons.find((b) => b.call === input.txName);
    // Where the station could have been sent from (#72). A failure here costs
    // only the sites: the answer is kept (D1), and null means "lookup failed".
    let txSites: SiteCandidate[] | undefined;
    if (listed) {
      try {
        txSites = sitesHeard(listed, getSites(), input.txName, freqKhz, now);
      } catch (error) {
        console.warn("reports.submit: couldn't work out the transmitter sites:", error);
      }
    }
    let fit = pick;
    // Only a beacon's slot bounds when the pick was made (PICK_IN_SLOT_MS).
    if (pick && !pickChecks(pick, { ...input, slotStartMs: input.txKind === "beacon" ? slot : undefined }, now)) {
      console.warn("reports.submit: dropped pick context that doesn't fit the report");
      fit = undefined;
    }
    await ctx.db.receptionReport.create({
      data: {
        ...report,
        // A signal station's detail is the channel the server checked, not the page's word.
        ...(input.txKind === "signal" && { txDetail: String(freqKhz) }),
        // The slot is kept for beacons and Priyom's numbers stations only.
        ...(slot !== undefined && { slotStartMs: BigInt(slot) }),
        ...(official && { beaconStatus: official.off ? "OFF" : "OK" }),
        ...(rbn && rbnDay && { rbnSpots: rbn.spots, rbnDay: rbnDay.day }),
        ...(txSites && { txSites }),
        // The question's rule and region, for a station only; a region only with a rule.
        ...(input.txKind === "eibi" && askRule !== undefined && { askRule, ...(askRegion && { askRegion }) }),
        ...(fit && {
          pickVersion: fit.version,
          pickedAtMs: BigInt(fit.pickedAtMs),
          pickSource: fit.pickSource,
          rankPos: fit.rankPos,
          candidates: fit.candidates,
          candidatesListed: listedCandidates(fit.candidates, served),
          pickLat: fit.lat,
          pickLon: fit.lon,
          pickSnr: fit.snr,
          pickUsers: fit.users,
        }),
      },
    });
    return { accepted: true };
  }),
});
