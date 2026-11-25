-- CreateIndex
-- CONCURRENTLY, so reports.submit keeps writing while it builds (#102 review). It must stay the
-- only statement here: Postgres refuses CONCURRENTLY inside a transaction block, and Prisma
-- applies a lone statement outside one (checked with prisma migrate deploy on Postgres 16).
-- If a build fails partway (a cancelled deploy, a dropped connection), Postgres keeps an
-- INVALID index and Prisma marks this migration failed, so later deploys stop (P3009).
-- Recover with: DROP INDEX CONCURRENTLY IF EXISTS "ReceptionReport_txKind_createdAt_idx";
-- then: prisma migrate resolve --rolled-back 20261127000000_reception_report_kind_index
-- and redeploy.
CREATE INDEX CONCURRENTLY "ReceptionReport_txKind_createdAt_idx" ON "ReceptionReport"("txKind", "createdAt");
