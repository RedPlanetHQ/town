// Town-scoped activity log.
//
// Surfaces the events the FEED panel renders on /{slug}. Every kind has
// the same row shape (TownActivity) — kind-specific data lives in
// `metadata` so adding a new kind is a one-line caller change.
//
// Dedupe is handled here, not at the call sites, so the rules stay in
// one file:
//   • visit / npc_chat / group_chat_started — skip if a matching row
//     exists in the last hour (per-kind key).
//   • tag_awarded — emit once per VisitorTag row (callers gate on the
//     upsert's "created" branch, no lookback needed here).
//   • item_awarded — emit every time (one row per VisitorItem).
//
// All writes are best-effort: a DB hiccup here must not break the
// underlying user action (a chat reply, a tag grant). Callers wrap with
// `.catch()` and ignore.

import type { Prisma } from "@town/db";

import { prisma } from "@/lib/db";

export type TownActivityKind =
  | "visit"
  | "npc_chat"
  | "tag_awarded"
  | "item_awarded"
  | "group_chat_started";

const DEDUPE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface RecordTownActivityInput {
  townSlug: string;
  kind: TownActivityKind;
  subjectKey: string;
  subjectName: string;
  subjectCharacter?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Insert one activity row for the FEED panel. Returns the created row,
 * or `null` when the write was skipped by dedupe.
 *
 * Callers should not rely on the return value — the helper is best-effort
 * and may throw on infrastructure errors. Wrap in `.catch()` at the
 * call site so a feed write can never break the underlying action.
 */
export async function recordTownActivity(
  input: RecordTownActivityInput,
): Promise<{ id: string } | null> {
  const metadata = input.metadata ?? {};

  if (shouldDedupeByKindAndSubject(input.kind)) {
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const existing = await prisma.townActivity.findFirst({
      where: {
        townSlug: input.townSlug,
        kind: input.kind,
        subjectKey: input.subjectKey,
        createdAt: { gte: since },
        // For npc_chat we also key on the NPC so chatting to a different
        // NPC inside the same window still emits.
        ...(input.kind === "npc_chat" && typeof metadata.npcId === "string"
          ? { metadata: { path: ["npcId"], equals: metadata.npcId } }
          : {}),
        // For group_chat_started we key on the building so a different
        // room in the same town isn't suppressed.
        ...(input.kind === "group_chat_started" &&
        typeof metadata.buildingId === "string"
          ? { metadata: { path: ["buildingId"], equals: metadata.buildingId } }
          : {}),
      },
      select: { id: true },
    });
    if (existing) return null;
  }

  const row = await prisma.townActivity.create({
    data: {
      townSlug: input.townSlug,
      kind: input.kind,
      subjectKey: input.subjectKey,
      subjectName: input.subjectName,
      subjectCharacter: input.subjectCharacter ?? null,
      metadata: metadata as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return row;
}

function shouldDedupeByKindAndSubject(kind: TownActivityKind): boolean {
  return (
    kind === "visit" || kind === "npc_chat" || kind === "group_chat_started"
  );
}
