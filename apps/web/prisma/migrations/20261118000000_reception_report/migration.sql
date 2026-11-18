-- CreateTable
CREATE TABLE "ReceptionReport" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "listenerId" TEXT NOT NULL,
    "receiverHost" TEXT NOT NULL,
    "receiverPort" INTEGER NOT NULL,
    "freqKhz" DOUBLE PRECISION NOT NULL,
    "mode" TEXT NOT NULL,
    "txKind" TEXT NOT NULL,
    "txName" TEXT NOT NULL,
    "txDetail" TEXT,
    "outcome" TEXT NOT NULL,
    "comment" TEXT,

    CONSTRAINT "ReceptionReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceptionReport_receiverHost_receiverPort_freqKhz_idx" ON "ReceptionReport"("receiverHost", "receiverPort", "freqKhz");

-- CreateIndex
CREATE INDEX "ReceptionReport_listenerId_createdAt_idx" ON "ReceptionReport"("listenerId", "createdAt");
