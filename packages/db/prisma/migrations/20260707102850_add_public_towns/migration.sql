-- AlterTable
ALTER TABLE "Town" ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TownVisit" (
    "id" TEXT NOT NULL,
    "townId" TEXT NOT NULL,
    "viewerKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TownVisit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TownVisit_townId_idx" ON "TownVisit"("townId");

-- CreateIndex
CREATE UNIQUE INDEX "TownVisit_townId_viewerKey_key" ON "TownVisit"("townId", "viewerKey");

-- AddForeignKey
ALTER TABLE "TownVisit" ADD CONSTRAINT "TownVisit_townId_fkey" FOREIGN KEY ("townId") REFERENCES "Town"("id") ON DELETE CASCADE ON UPDATE CASCADE;
