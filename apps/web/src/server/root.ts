import { presetsRouter } from "./routers/presets";
import { receiversRouter } from "./routers/receivers";
import { reportsRouter } from "./routers/reports";
import { stationsRouter } from "./routers/stations";
import { router } from "./trpc";

export const appRouter = router({
  presets: presetsRouter,
  receivers: receiversRouter,
  reports: reportsRouter,
  stations: stationsRouter,
});

export type AppRouter = typeof appRouter;
