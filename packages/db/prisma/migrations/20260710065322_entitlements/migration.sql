-- AlterTable
ALTER TABLE "Town" ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "maxActiveGuests" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "maxBuildings" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "maxCustomPlots" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "maxNpcs" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "xp" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "maxTotalCustomPlots" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "maxTowns" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "tier" TEXT NOT NULL DEFAULT 'free';

-- CreateTable
CREATE TABLE "EntitlementGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "townId" TEXT,
    "target" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "ref" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntitlementGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EntitlementGrant_userId_createdAt_idx" ON "EntitlementGrant"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EntitlementGrant_townId_createdAt_idx" ON "EntitlementGrant"("townId", "createdAt");

-- AddForeignKey
ALTER TABLE "EntitlementGrant" ADD CONSTRAINT "EntitlementGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntitlementGrant" ADD CONSTRAINT "EntitlementGrant_townId_fkey" FOREIGN KEY ("townId") REFERENCES "Town"("id") ON DELETE CASCADE ON UPDATE CASCADE;
