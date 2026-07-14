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
        ratePerDollar: Number(metadata.ratePerDollar),
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
  ratePerDollar: number;
  stripeSessionId: string;
}): Promise<void> {
  const auraToGrant = Math.floor((opts.amountCents / 100) * opts.ratePerDollar);
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
