import { presetsRouter } from "./routers/presets";
import { receiversRouter } from "./routers/receivers";
import { router } from "./trpc";

export const appRouter = router({
  presets: presetsRouter,
  receivers: receiversRouter,
});

export type AppRouter = typeof appRouter;
