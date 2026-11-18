import { z } from "zod";
import { scheduledOn, type Broadcast } from "@/lib/eibi";
import { beaconsBetween, ibpBandIndex } from "@/lib/ibp";
import { findReceiver } from "@/lib/kiwi-list";
import { MODES } from "@/lib/radio-types";
import { COMMENT_MAX, LISTING_GRACE_MS, MAX_LISTED, OUTCOMES, TX_KINDS, TX_NAME_SEPARATOR } from "@/lib/reception";
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
 * Whether the beacon `call` was on the band `freqKhz` is tuned to at some 10 s
 * slot in the last LISTING_GRACE_MS, by this server's clock. The page asks
 * once that slot's end reaches the listener and closes the prompt well before
 * this window passes it.
 */
export function beaconRecently(call: string, freqKhz: number, ms: number) {
  const band = ibpBandIndex(freqKhz);
  return band >= 0 && beaconsBetween(band, ms - LISTING_GRACE_MS, ms).some((b) => b.call === call);
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

/**
 * One report per listener, receiver and frequency in this long: a second
 * answer about the same channel this soon adds nothing (and the prompt
 * itself waits 10 minutes between asks).
 */
export const SAME_CHANNEL_MS = 30 * MINUTE;

/**
 * Reports about one receiver in a rolling hour, from everyone. The listener
 * id is made by the browser, so a script can send a fresh one with every
 * report and never meet the per-listener limits; this cap bounds what such
 * a flood can add to any one receiver's data (issue #60's "cap per receiver
 * per hour"). A real hour seldom sees more than a handful. The cost: a flood
 * also crowds out genuine reports for that receiver until the hour rolls.
 */
export const RECEIVER_REPORTS_PER_HOUR = 30;

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
  outcome: z.enum(OUTCOMES),
  comment: optionalText(COMMENT_MAX),
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
    // beacon the clock had on that band). From this server's cached copies;
    // neither fetches per request.
    if (input.txKind === "beacon") {
      if (!beaconRecently(input.txName, freqKhz, now)) return { accepted: false };
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
          createdAt: { gte: new Date(now - SAME_CHANNEL_MS) },
        },
      }),
    ]);
    if (lastHour >= REPORTS_PER_HOUR || receiverHour >= RECEIVER_REPORTS_PER_HOUR || sameChannel > 0)
      return { accepted: false };
    await ctx.db.receptionReport.create({ data: input });
    return { accepted: true };
  }),
});
