-- CreateTable
CREATE TABLE "Preset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "freqKhz" DOUBLE PRECISION NOT NULL,
    "mode" TEXT NOT NULL,
    "receiverHost" TEXT,
    "receiverPort" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Preset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Preset_freqKhz_idx" ON "Preset"("freqKhz");
