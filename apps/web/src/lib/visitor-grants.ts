// VisitorIntegrationGrant helpers.
//
// A signed-in visitor can lend an NPC access to THEIR OWN CORE integration.
// These are the pure DB helpers — no CORE calls. The token routing that
// actually uses these grants lives in npc-tools.ts (buildNpcTools); the
// consent UI is fed by /api/npcs/[id]/visitor-access.
//
// "Active" always means revokedAt = null. Revoking is a soft-delete so the
// grant history stays auditable and re-granting is an upsert (un-revoke).

import { prisma } from "./db";

export interface VisitorGrant {
  slug: string;
  /** [] = whole integration (level-1). */
  actions: string[];
}

/** Load the visitor's active grants for one NPC — the chat-time read. */
export async function loadActiveVisitorGrants(
  npcId: string,
  visitorUserId: string,
): Promise<VisitorGrant[]> {
  const rows = await prisma.visitorIntegrationGrant.findMany({
    where: { npcId, visitorUserId, revokedAt: null },
    select: { slug: true, actions: true },
  });
  return rows.map((r) => ({ slug: r.slug, actions: r.actions }));
}

/**
 * Replace the visitor's grant set for one NPC with `slugs`.
 * - slugs present  → upsert an active grant (clears any prior revokedAt).
 * - slugs absent   → revoke (soft-delete) any active grant not in the set.
 * Runs in a transaction so the popover's "save" is atomic.
 */
export async function replaceVisitorGrants(params: {
  townId: string;
  npcId: string;
  visitorUserId: string;
  slugs: string[];
}): Promise<void> {
  const { townId, npcId, visitorUserId, slugs } = params;
  const wanted = new Set(slugs);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.visitorIntegrationGrant.findMany({
      where: { npcId, visitorUserId },
      select: { slug: true, revokedAt: true },
    });

    // Upsert everything the visitor now wants (un-revoking as needed).
    for (const slug of wanted) {
      await tx.visitorIntegrationGrant.upsert({
        where: {
          npcId_visitorUserId_slug: { npcId, visitorUserId, slug },
        },
        update: { revokedAt: null },
        create: { townId, npcId, visitorUserId, slug },
      });
    }

    // Revoke anything active that the visitor no longer wants.
    const toRevoke = existing
      .filter((e) => !wanted.has(e.slug) && e.revokedAt === null)
      .map((e) => e.slug);
    if (toRevoke.length > 0) {
      await tx.visitorIntegrationGrant.updateMany({
        where: { npcId, visitorUserId, slug: { in: toRevoke } },
        data: { revokedAt: new Date() },
      });
    }
  });
}

/** Revoke every active grant this visitor made to this NPC. */
export async function revokeAllVisitorGrants(
  npcId: string,
  visitorUserId: string,
): Promise<void> {
  await prisma.visitorIntegrationGrant.updateMany({
    where: { npcId, visitorUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
