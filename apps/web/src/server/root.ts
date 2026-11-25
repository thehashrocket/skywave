import { beaconsRouter } from "./routers/beacons";
import { presetsRouter } from "./routers/presets";
import { receiversRouter } from "./routers/receivers";
import { reportsRouter } from "./routers/reports";
import { signalsRouter } from "./routers/signals";
import { stationsRouter } from "./routers/stations";
import { router } from "./trpc";

export const appRouter = router({
  beacons: beaconsRouter,
  presets: presetsRouter,
  receivers: receiversRouter,
  reports: reportsRouter,
  signals: signalsRouter,
  stations: stationsRouter,
});

export type AppRouter = typeof appRouter;
