// Server-authoritative grant router. Everything the webhook writes
// flows through here. Adding a new purchase intent = add a new case.
//
// Idempotent per Stripe session: the same `stripeSessionId` will only
// grant once. Prisma's unique index isn't set on
// `EntitlementGrant.ref`, so we guard with a lookup — cheap and safe.

import { prisma } from "@/lib/db";
import type { CheckoutMetadata } from "@/lib/stripe";

export async function applyStripeGrant(opts: {
  metadata: CheckoutMetadata;
  amountCents: number;
  stripeSessionId: string;
}): Promise<void> {
  const { metadata, amountCents, stripeSessionId } = opts;

  const existing = await prisma.entitlementGrant.findFirst({
    where: { ref: stripeSessionId, source: "purchase" },
    select: { id: true },
  });
  if (existing) return;

  switch (metadata.intent) {
    case "aura_pack":
      await grantAuraPack({
        userId: metadata.userId,
        townId: metadata.townId,
        amountCents,
        auraAmount: Number(metadata.auraAmount),
        stripeSessionId,
      });
      break;
    case "aura_upgrade":
      await grantAuraUpgrade({
        userId: metadata.userId,
        townId: metadata.townId,
        newMax: Number(metadata.newMax),
        stripeSessionId,
      });
      break;
    case "town_slot":
      await grantTownSlot({
        userId: metadata.userId,
        stripeSessionId,
      });
      break;
  }
}

async function grantAuraPack(opts: {
  userId: string;
  townId: string;
  amountCents: number;
  auraAmount: number;
  stripeSessionId: string;
}): Promise<void> {
  const auraToGrant = Math.max(0, Math.floor(opts.auraAmount));
  if (auraToGrant <= 0) return;

  // Add to `current` only. `max` stays put, so a top-up gives a burst
  // above the cap that the player spends down; regen keeps refilling
  // toward `max` in the background as normal.
  await prisma.aura.update({
    where: { townId: opts.townId },
    data: { current: { increment: auraToGrant } },
  });

  await prisma.entitlementGrant.create({
    data: {
      userId: opts.userId,
      townId: opts.townId,
      target: "aura",
      delta: auraToGrant,
      source: "purchase",
      reason: `stripe:${(opts.amountCents / 100).toFixed(2)}usd`,
      ref: opts.stripeSessionId,
    },
  });
}

async function grantAuraUpgrade(opts: {
  userId: string;
  townId: string;
  newMax: number;
  stripeSessionId: string;
}): Promise<void> {
  const target = Math.max(0, Math.floor(opts.newMax));
  if (target <= 0) return;

  // Idempotent + monotonic: only raises the cap. Also bumps `current`
  // by the same delta so the upgrade feels immediate — otherwise the
  // town would still be sitting at its old current value.
  const row = await prisma.aura.findUnique({
    where: { townId: opts.townId },
    select: { current: true, max: true },
  });
  if (!row) return;
  if (row.max >= target) {
    // Already at or above this cap — log the grant anyway for audit
    // + refund tooling, but don't touch the row.
    await prisma.entitlementGrant.create({
      data: {
        userId: opts.userId,
        townId: opts.townId,
        target: "auraMax",
        delta: 0,
        source: "purchase",
        reason: `stripe:cap-noop:${target}`,
        ref: opts.stripeSessionId,
      },
    });
    return;
  }

  const delta = target - row.max;
  await prisma.aura.update({
    where: { townId: opts.townId },
    data: {
      max: target,
      current: { increment: delta },
    },
  });

  await prisma.entitlementGrant.create({
    data: {
      userId: opts.userId,
      townId: opts.townId,
      target: "auraMax",
      delta,
      source: "purchase",
      reason: `stripe:cap-${target}`,
      ref: opts.stripeSessionId,
    },
  });
}

async function grantTownSlot(opts: {
  userId: string;
  stripeSessionId: string;
}): Promise<void> {
  await prisma.user.update({
    where: { id: opts.userId },
    data: { maxTowns: { increment: 1 } },
  });

  await prisma.entitlementGrant.create({
    data: {
      userId: opts.userId,
      target: "maxTowns",
      delta: 1,
      source: "purchase",
      reason: "stripe:town_slot",
      ref: opts.stripeSessionId,
    },
  });
}
