-- CreateIndex
-- CONCURRENTLY, so reports.submit keeps writing while it builds (#102 review). It must stay the
-- only statement here: Postgres refuses CONCURRENTLY inside a transaction block, and Prisma
-- applies a lone statement outside one (checked with prisma migrate deploy on Postgres 16).
CREATE INDEX CONCURRENTLY "ReceptionReport_txKind_createdAt_idx" ON "ReceptionReport"("txKind", "createdAt");
