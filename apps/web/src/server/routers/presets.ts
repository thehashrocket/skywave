import { z } from "zod";
import { MODES } from "@/lib/radio-types";
import { publicProcedure, router } from "../trpc";

const presetInput = z.object({
  name: z.string().trim().min(1).max(80),
  freqKhz: z.number().positive().max(32_000),
  mode: z.enum(MODES),
  receiverHost: z.string().trim().max(253).optional(),
  receiverPort: z.number().int().min(1).max(65_535).optional(),
});

export const presetsRouter = router({
  list: publicProcedure.query(({ ctx }) => ctx.db.preset.findMany({ orderBy: { freqKhz: "asc" } })),

  create: publicProcedure.input(presetInput).mutation(({ ctx, input }) => ctx.db.preset.create({ data: input })),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => ctx.db.preset.delete({ where: { id: input.id } })),
});
