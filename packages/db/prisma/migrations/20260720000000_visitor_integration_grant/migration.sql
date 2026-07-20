-- CreateTable
CREATE TABLE "VisitorIntegrationGrant" (
    "id" TEXT NOT NULL,
    "townId" TEXT NOT NULL,
    "npcId" TEXT NOT NULL,
    "visitorUserId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "actions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitorIntegrationGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VisitorIntegrationGrant_npcId_visitorUserId_idx" ON "VisitorIntegrationGrant"("npcId", "visitorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "VisitorIntegrationGrant_npcId_visitorUserId_slug_key" ON "VisitorIntegrationGrant"("npcId", "visitorUserId", "slug");

-- AddForeignKey
ALTER TABLE "VisitorIntegrationGrant" ADD CONSTRAINT "VisitorIntegrationGrant_townId_fkey" FOREIGN KEY ("townId") REFERENCES "Town"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorIntegrationGrant" ADD CONSTRAINT "VisitorIntegrationGrant_npcId_fkey" FOREIGN KEY ("npcId") REFERENCES "Npc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorIntegrationGrant" ADD CONSTRAINT "VisitorIntegrationGrant_visitorUserId_fkey" FOREIGN KEY ("visitorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
