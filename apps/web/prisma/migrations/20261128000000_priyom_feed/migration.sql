-- CreateTable
CREATE TABLE "PriyomFeed" (
    "id" TEXT NOT NULL,
    "trackedSince" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "changedAt" TIMESTAMP(3),
    "transmissions" JSONB NOT NULL,

    CONSTRAINT "PriyomFeed_pkey" PRIMARY KEY ("id")
);
