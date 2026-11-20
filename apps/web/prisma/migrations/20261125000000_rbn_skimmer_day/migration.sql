-- CreateTable
CREATE TABLE "RbnSkimmerDay" (
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "total" INTEGER NOT NULL,
    "skimmers" JSONB NOT NULL,
    "raw" BYTEA NOT NULL,

    CONSTRAINT "RbnSkimmerDay_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "RbnSkimmerRefusal" (
    "day" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "total" INTEGER,
    "raw" BYTEA NOT NULL,

    CONSTRAINT "RbnSkimmerRefusal_pkey" PRIMARY KEY ("day","fetchedAt")
);
