-- Per-NPC capability grant. Lists which CORE tools (integrations,
-- tasks, reminders, memory search, skills) the NPC may invoke during
-- chat. Shape mirrors NpcPermissions in
-- apps/web/src/lib/npc-templates.ts. Null = no tools (existing rows
-- backfill via getNpcTemplate(plotKey) at chat time, then get the
-- template's grant copied in on next seed).

ALTER TABLE "Npc" ADD COLUMN "permissions" JSONB;
