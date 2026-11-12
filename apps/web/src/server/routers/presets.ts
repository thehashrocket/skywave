import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { sitePublic } from "@/lib/site";
import { MODES } from "@/lib/radio-types";
import { publicProcedure, router } from "../trpc";

const presetInput = z.object({
  name: z.string().trim().min(1).max(80),
  freqKhz: z.number().positive().max(32_000),
  mode: z.enum(MODES),
  receiverHost: z.string().trim().max(253).optional(),
  receiverPort: z.number().int().min(1).max(65_535).optional(),
});

// On a public site the shared list is read-only: anyone could otherwise
// rewrite it for everyone, or fill the database. Browsers save their own.
const writable = publicProcedure.use(({ next }) => {
  if (sitePublic()) throw new TRPCError({ code: "FORBIDDEN", message: "Shared presets are read-only here." });
  return next();
});

export const presetsRouter = router({
  list: publicProcedure.query(({ ctx }) => ctx.db.preset.findMany({ orderBy: { freqKhz: "asc" } })),

  create: writable.input(presetInput).mutation(({ ctx, input }) => ctx.db.preset.create({ data: input })),

  // deleteMany, not delete: removing a preset that's already gone (double
  // click, second tab) is a success, not a 500.
  delete: writable
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => ctx.db.preset.deleteMany({ where: { id: input.id } })),
});
