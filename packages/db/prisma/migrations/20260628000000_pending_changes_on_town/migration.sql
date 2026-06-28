-- Move pendingChanges from CreatorConversation to Town so the staged
-- queue survives across conversations + CLI restarts. Only an explicit
-- Clear or Approve (or remove_pending_change from the agent) drops the
-- entries.

-- 1. Add the column on Town with empty-array default.
ALTER TABLE "Town" ADD COLUMN "pendingChanges" JSONB NOT NULL DEFAULT '[]';

-- 2. Backfill: for each Town, copy the queue from the most recent
--    active CreatorConversation (one active per (townId, userId) by
--    contract). If multiple users had active conversations per town,
--    the most recently updated one wins — closest to user intent.
UPDATE "Town" t
SET "pendingChanges" = COALESCE(
  (SELECT cc."pendingChanges"
   FROM "CreatorConversation" cc
   WHERE cc."townId" = t.id
     AND cc."status" = 'active'
   ORDER BY cc."updatedAt" DESC
   LIMIT 1),
  '[]'::jsonb
);

-- 3. Drop the now-redundant column from CreatorConversation.
ALTER TABLE "CreatorConversation" DROP COLUMN "pendingChanges";
