import { presetsRouter } from "./routers/presets";
import { router } from "./trpc";

export const appRouter = router({
  presets: presetsRouter,
});

export type AppRouter = typeof appRouter;
