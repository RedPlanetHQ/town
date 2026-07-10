// Small aura helpers that don't fit naturally on token-usage.ts.
//
// creditFirstVisitAura — called from /{town}/page.tsx on a visitor's
// first-ever visit to a town (dedupe key: TownActivity has no prior
// "visit" row for this subjectKey). Adds AURA_GUEST_CREDIT to the
// town's current aura, clamped to `max`.

import { prisma } from "./db";

export const AURA_GUEST_CREDIT = 5;

/** Credit AURA_GUEST_CREDIT aura the first time this visitor lands on
 *  this town. Idempotent: once a TownActivity `visit` row exists for
 *  (townSlug, subjectKey), further calls no-op.
 *
 *  Fire-and-forget from the page — the visit path can't be blocked on
 *  this write. */
export async function creditFirstVisitAura(input: {
  townId: string;
  townSlug: string;
  subjectKey: string;
}): Promise<void> {
  try {
    const existing = await prisma.townActivity.findFirst({
      where: {
        townSlug: input.townSlug,
        subjectKey: input.subjectKey,
        kind: "visit",
      },
      select: { id: true },
    });
    if (existing) return;
    await prisma.$executeRaw`
      UPDATE core."Aura"
         SET current = LEAST(current + ${AURA_GUEST_CREDIT}, max),
             "updatedAt" = NOW()
       WHERE "townId" = ${input.townId}
    `;
  } catch (e) {
    console.warn("[aura] first-visit credit failed", e);
  }
}
