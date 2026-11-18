import { z } from "zod";
import { MODES } from "@/lib/radio-types";
import { COMMENT_MAX, OUTCOMES } from "@/lib/reception";
import { publicProcedure, router } from "../trpc";

const MINUTE = 60_000;

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
  // Only EiBi listings until beacon mode (#59) adds "beacon"; the column is text.
  txKind: z.literal("eibi"),
  txName: z.string().trim().min(1).max(200),
  txDetail: optionalText(100),
  outcome: z.enum(OUTCOMES),
  comment: optionalText(COMMENT_MAX),
});

export type ReportInput = z.input<typeof reportInput>;

export const reportsRouter = router({
  /**
   * Store one reception report. Over a limit it answers { accepted: false }
   * rather than an error: the listener has nothing to fix, so nothing to show.
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
