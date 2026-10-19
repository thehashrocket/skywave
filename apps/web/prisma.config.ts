import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  // Not env("DATABASE_URL"): that throws when the variable is unset, which
  // breaks `prisma generate` in postinstall on a fresh clone. Generate doesn't
  // need a database; migrate and seed still fail clearly without one.
  datasource: { url: process.env.DATABASE_URL },
});
