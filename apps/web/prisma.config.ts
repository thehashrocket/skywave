import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  // Not env("DATABASE_URL"): that throws when the variable is unset, which
  // breaks `prisma generate` in postinstall on a fresh clone. Generate doesn't
  // need a database; migrate and seed still fail clearly without one.
  // Neon's Vercel integration also sets DATABASE_URL_UNPOOLED; migrate needs
  // that direct connection, since its pooled URL goes through PgBouncer.
  datasource: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL },
});
