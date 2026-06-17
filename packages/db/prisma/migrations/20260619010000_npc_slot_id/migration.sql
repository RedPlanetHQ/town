-- Multi-NPC per building. Each NPC binds to one slot in its variant's
-- npcPositions list; existing rows are the implicit "first slot" so we
-- default to ''.

-- AlterTable
ALTER TABLE "Npc" ADD COLUMN "slotId" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "Npc_userId_buildingId_slotId_idx" ON "Npc"("userId", "buildingId", "slotId");
