-- AlterTable
ALTER TABLE "ReceptionReport" ADD COLUMN "rbnDay" TEXT,
ADD COLUMN "rbnSpots" INTEGER;

-- CreateTable
CREATE TABLE "RbnBeaconDay" (
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total" INTEGER NOT NULL,
    "beacons" JSONB NOT NULL,

    CONSTRAINT "RbnBeaconDay_pkey" PRIMARY KEY ("day")
);
