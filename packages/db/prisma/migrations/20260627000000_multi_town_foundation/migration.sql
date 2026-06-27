-- Multi-town foundation: pivot dependent rows from userId → townId,
-- drop the single-town invariants (Town.ownerId unique, User.coreUserId
-- unique), add the composite (coreUserId, workspaceId) identity, and
-- introduce the Aura table with one row per existing Town.
--
-- The migration is data-preserving:
--   1. Add nullable townId columns where missing + Aura table.
--   2. Backfill from Town.ownerId (today's uniqueness invariant makes
--      every dependent row map unambiguously to one town).
--   3. Hard-delete orphans (pre-onboarding rows that point at no Town).
--   4. Tighten: drop old PKs/FKs/uniques, repivot PlotRow PK, add the
--      composite User unique.

-- ---------------------------------------------------------------------
-- 1. ADD NULLABLE COLUMNS + AURA TABLE
-- ---------------------------------------------------------------------

ALTER TABLE "Npc"            ADD COLUMN "townId" TEXT;
ALTER TABLE "PlotSuggestion" ADD COLUMN "townId" TEXT;

CREATE TABLE "Aura" (
  "townId"    TEXT NOT NULL,
  "current"   INTEGER NOT NULL DEFAULT 1000,
  "max"       INTEGER NOT NULL DEFAULT 1000,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Aura_pkey" PRIMARY KEY ("townId")
);
ALTER TABLE "Aura" ADD CONSTRAINT "Aura_townId_fkey"
  FOREIGN KEY ("townId") REFERENCES "Town"("id")
  ON UPDATE CASCADE ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- 2. BACKFILL FROM TOWN.OWNERID
-- ---------------------------------------------------------------------
-- PlotRow.townId already exists from a prior migration. Backfill any
-- rows whose townId never got linked (existed before the link
-- migration ran).

UPDATE "PlotRow"
SET "townId" = t.id
FROM "Town" t
WHERE t."ownerId" = "PlotRow"."userId"
  AND "PlotRow"."townId" IS NULL;

UPDATE "Npc"
SET "townId" = t.id
FROM "Town" t
WHERE t."ownerId" = "Npc"."userId";

UPDATE "PlotSuggestion"
SET "townId" = t.id
FROM "Town" t
WHERE t."ownerId" = "PlotSuggestion"."userId";

INSERT INTO "Aura" ("townId", "current", "max", "updatedAt")
SELECT id, 1000, 1000, CURRENT_TIMESTAMP FROM "Town";

-- ---------------------------------------------------------------------
-- 3. HARD-DELETE ORPHANS (pre-onboarding state; regenerates on next visit)
-- ---------------------------------------------------------------------

DELETE FROM "PlotRow"        WHERE "townId" IS NULL;
DELETE FROM "Npc"            WHERE "townId" IS NULL;
DELETE FROM "PlotSuggestion" WHERE "townId" IS NULL;

-- ---------------------------------------------------------------------
-- 4. TIGHTEN
-- ---------------------------------------------------------------------

-- 4a. PlotRow: repivot PK from userId to townId, drop userId column + FKs,
--     swap the existing SET NULL FK for CASCADE.
ALTER TABLE "PlotRow" ALTER COLUMN "townId" SET NOT NULL;
ALTER TABLE "PlotRow" DROP CONSTRAINT "PlotRow_userId_fkey";
ALTER TABLE "PlotRow" DROP CONSTRAINT "PlotRow_townId_fkey";
ALTER TABLE "PlotRow" DROP CONSTRAINT "PlotRow_pkey";
DROP INDEX IF EXISTS "PlotRow_townId_key";
ALTER TABLE "PlotRow" DROP COLUMN "userId";
ALTER TABLE "PlotRow" ADD CONSTRAINT "PlotRow_pkey" PRIMARY KEY ("townId");
ALTER TABLE "PlotRow" ADD CONSTRAINT "PlotRow_townId_fkey"
  FOREIGN KEY ("townId") REFERENCES "Town"("id")
  ON UPDATE CASCADE ON DELETE CASCADE;

-- 4b. Npc: drop old userId FK + indexes, drop column, add townId FK + indexes.
ALTER TABLE "Npc" ALTER COLUMN "townId" SET NOT NULL;
DROP INDEX IF EXISTS "Npc_userId_idx";
DROP INDEX IF EXISTS "Npc_userId_buildingId_idx";
DROP INDEX IF EXISTS "Npc_userId_buildingId_slotId_idx";
ALTER TABLE "Npc" DROP CONSTRAINT "Npc_userId_fkey";
ALTER TABLE "Npc" DROP COLUMN "userId";
ALTER TABLE "Npc" ADD CONSTRAINT "Npc_townId_fkey"
  FOREIGN KEY ("townId") REFERENCES "Town"("id")
  ON UPDATE CASCADE ON DELETE CASCADE;
CREATE INDEX "Npc_townId_idx"
  ON "Npc"("townId");
CREATE INDEX "Npc_townId_buildingId_idx"
  ON "Npc"("townId", "buildingId");
CREATE INDEX "Npc_townId_buildingId_slotId_idx"
  ON "Npc"("townId", "buildingId", "slotId");

-- 4c. PlotSuggestion: add townId FK + per-town status index.
ALTER TABLE "PlotSuggestion" ALTER COLUMN "townId" SET NOT NULL;
ALTER TABLE "PlotSuggestion" ADD CONSTRAINT "PlotSuggestion_townId_fkey"
  FOREIGN KEY ("townId") REFERENCES "Town"("id")
  ON UPDATE CASCADE ON DELETE CASCADE;
CREATE INDEX "PlotSuggestion_townId_status_idx"
  ON "PlotSuggestion"("townId", "status");

-- 4d. Town: drop the single-town uniqueness on ownerId, replace with index.
DROP INDEX "Town_ownerId_key";
CREATE INDEX "Town_ownerId_idx" ON "Town"("ownerId");

-- 4e. User: drop coreUserId-only unique, add composite (coreUserId, workspaceId).
DROP INDEX "User_coreUserId_key";
CREATE UNIQUE INDEX "User_coreUserId_workspaceId_key"
  ON "User"("coreUserId", "workspaceId");
