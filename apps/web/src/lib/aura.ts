// Small aura helpers that don't fit naturally on token-usage.ts.
//
// creditFirstVisitAura — called from /{town}/page.tsx on a visitor's
// first-ever visit to a town (dedupe key: TownActivity has no prior
// "visit" row for this subjectKey). Adds AURA_GUEST_CREDIT to the
// town's current aura, clamped to `max`.

import { prisma } from "./db";

export const AURA_GUEST_CREDIT = 10;
export const AURA_INTEGRATION_ACTION_COST = 10;

/** Debit aura by town slug (npc-tools only has the slug, not townId).
 *  Clamped at 0, same as the token-usage debit. Best-effort — callers
 *  fire-and-forget. Table names unqualified so the query resolves via
 *  the connection's search_path, matching the aura-regen worker. */
export async function debitAuraBySlug(
  townSlug: string,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;
  try {
    await prisma.$executeRaw`
      UPDATE "Aura" a
         SET current = GREATEST(a.current - ${amount}, 0),
             "updatedAt" = NOW()
        FROM "Town" t
       WHERE t.slug = ${townSlug}
         AND a."townId" = t.id
    `;
  } catch (e) {
    console.warn("[aura] integration-action debit failed", e);
  }
}

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
    // No schema prefix — the connection's search_path picks the right
    // one (public or core depending on DATABASE_URL). Hardcoding
    // `core.` failed on deploys whose DB uses `?schema=public`.
    await prisma.$executeRaw`
      UPDATE "Aura"
         SET current = LEAST(current + ${AURA_GUEST_CREDIT}, max),
             "updatedAt" = NOW()
       WHERE "townId" = ${input.townId}
    `;
  } catch (e) {
    console.warn("[aura] first-visit credit failed", e);
  }
}
