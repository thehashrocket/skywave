import { z } from "zod";
import { scheduledOn, type Broadcast } from "@/lib/eibi";
import { beaconOnBand, ibpBandIndex, SLOT_MS } from "@/lib/ibp";
import { findReceiver, MAX_PLAUSIBLE_SNR, MAX_ROWS } from "@/lib/kiwi-list";
import { MAX_CANDIDATES, PICK_SOURCES, pickKey } from "@/lib/pick-context";
import { MODES } from "@/lib/radio-types";
import {
  COMMENT_MAX,
  LISTING_GRACE_MS,
  MAX_LISTED,
  OUTCOMES,
  SAME_CHANNEL_MS,
  TX_KINDS,
  TX_NAME_SEPARATOR,
} from "@/lib/reception";
import { publicProcedure, router } from "../trpc";
import { getReceivers, servedReceivers } from "./receivers";
import { getSchedule } from "./stations";

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

/** Whether the receiver is on the public list as the page is served it (opted-out owners left out). */
async function listed(host: string, port: number): Promise<boolean> {
  try {
    return findReceiver(servedReceivers((await getReceivers()).receivers), host, port) !== undefined;
  } catch {
    // No list to check against (the mirror is down on a fresh server): can't vouch for it.
    return false;
  }
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

/**
 * A candidate as pickKey writes it: a lowercase hostname or IPv4 address (at
 * most 253 characters), a colon, a port. Anything else isn't a receiver key.
 */
const CANDIDATE_KEY = /^[a-z0-9._-]{1,253}:[0-9]{1,5}$/;

/**
 * How Pick best chose the receiver (issue #61, lib/pick-context.ts). The page
 * can't be vouched for, so this is checked, and bad context costs only
 * itself: owner decision D6 keeps the answer, which is the scarce part. The
 * values themselves (position, SNR, users) can't be checked against the list
 * as it was at pick time; only their shape and ranges are.
 */
const pickInput = z
  .object({
    pickedAtMs: z.number().int().positive(),
    pickSource: z.enum(PICK_SOURCES),
    // A place in a list of at most MAX_ROWS receivers, from 0.
    rankPos: z.number().int().min(0).max(MAX_ROWS - 1),
    candidates: z
      .array(z.string().regex(CANDIDATE_KEY))
      .min(1)
      .max(MAX_CANDIDATES)
      .refine((keys) => new Set(keys).size === keys.length, "duplicate candidate"),
    freqKhz: z.number().positive().max(32_000),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    snr: z.number().min(0).max(MAX_PLAUSIBLE_SNR).nullable(),
    users: z.number().int().min(0).max(1_000),
  })
  // pickContext keeps a position only when both halves are known.
  .refine((p) => (p.lat === undefined) === (p.lon === undefined), { path: ["lat"], message: "lat without lon" });
type PickInput = z.infer<typeof pickInput>;

/**
 * Whether a well-formed pick fits the report it came with: ranked for the
 * frequency answered about, made before the beacon slot asked about (and not
 * in the future or long ago, by this server's clock), and naming the
 * answered receiver at its rank when that's among the candidates.
 */
export function pickChecks(
  pick: PickInput,
  report: { receiverHost: string; receiverPort: number; freqKhz: number; slotStartMs?: number },
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
    pickedAtMs <= ms + MAX_CLOCK_SKEW_MS &&
    pickedAtMs >= ms - MAX_PICK_AGE_MS &&
    (report.slotStartMs === undefined || pickedAtMs < report.slotStartMs)
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

const reportInput = z.object({
  listenerId: z.uuid(),
  // Lowercase, as receiverKey compares them, so one receiver isn't two in the data.
  receiverHost: z.string().trim().toLowerCase().min(1).max(253),
  receiverPort: z.number().int().min(1).max(65_535),
  freqKhz: z.number().positive().max(32_000),
  mode: z.enum(MODES),
  // An EiBi listing, or an IBP beacon (#59) by callsign; the column is text.
  txKind: z.enum(TX_KINDS),
  txName: z.string().trim().min(1).max(200),
  txDetail: optionalText(100),
  // Beacons: the UTC start of the 10 s slot asked about (beaconSlotChecks).
  slotStartMs: z.number().int().optional(),
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
    // beacon the schedule had on that band in the slot asked about). From this
    // server's cached copies; neither fetches per request.
    const { slotStartMs, pick, ...report } = input;
    if (input.txKind === "beacon") {
      if (slotStartMs === undefined || !beaconSlotChecks(input.txName, freqKhz, slotStartMs, now))
        return { accepted: false };
    } else {
      const { broadcasts } = await getSchedule();
      if (!scheduledRecently(broadcasts, input.txName, freqKhz, now)) return { accepted: false };
    }
    if (!(await listed(receiverHost, receiverPort))) return { accepted: false };
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
          // A beacon frequency carries a new beacon every 10 s: each callsign is its own channel.
          ...(input.txKind === "beacon" && { txKind: "beacon", txName: input.txName }),
          createdAt: { gte: new Date(now - SAME_CHANNEL_MS) },
        },
      }),
    ]);
    if (lastHour >= REPORTS_PER_HOUR || receiverHour >= RECEIVER_REPORTS_PER_HOUR || sameChannel > 0)
      return { accepted: false };
    const slot = input.txKind === "beacon" ? slotStartMs : undefined;
    let fit = pick;
    if (pick && !pickChecks(pick, { ...input, slotStartMs: slot }, now)) {
      console.warn("reports.submit: dropped pick context that doesn't fit the report");
      fit = undefined;
    }
    await ctx.db.receptionReport.create({
      data: {
        ...report,
        // The slot is kept for beacons only.
        ...(slot !== undefined && { slotStartMs: BigInt(slot) }),
        ...(fit && {
          pickedAtMs: BigInt(fit.pickedAtMs),
          pickSource: fit.pickSource,
          rankPos: fit.rankPos,
          candidates: fit.candidates,
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
