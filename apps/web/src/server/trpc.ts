import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { db } from "./db";

export const createContext = async () => ({ db });

const t = initTRPC.context<typeof createContext>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;
