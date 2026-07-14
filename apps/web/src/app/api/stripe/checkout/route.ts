// POST /api/stripe/checkout
//
// Creates a Stripe Checkout Session server-side. The client never
// touches Stripe API keys; the amount is decided here based on the
// requested intent + tier, and metadata is attached so the webhook
// can re-decide what to grant on `checkout.session.completed`.
//
// Gated on `PRICING_ENABLED`. Returns 403 when the flag is off, so
// the UI's guards are backstopped by the server.

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { isPricingEnabled } from "@/lib/pricing";
import { getSessionFromCookie } from "@/lib/session";
import { getStripe, type CheckoutMetadata } from "@/lib/stripe";

export const runtime = "nodejs";

// Tiered aura packs — bigger buys get a better per-aura rate.
// Order matters: the /api/stripe/checkout GET returns this shape so
// the UI can render the tiers without duplicating the constants.
const AURA_TIERS = [
  { cents:  500, aura:  100 }, // $5  → 100 aura
  { cents: 1000, aura:  500 }, // $10 → 500 aura (5×)
  { cents: 1500, aura: 1000 }, // $15 → 1000 aura (10×)
] as const;

// Per-town permanent aura cap upgrade — one-time purchase, raises
// `Aura.max` to `newMax`. Also bumps `current` by the delta so the
// upgrade feels immediate.
const AURA_UPGRADES = [
  { cents: 5000, newMax: 10000 }, // $50 → 10,000 max
] as const;

const TOWN_SLOT_CENTS = 1000;                            // $10 for +1 slot

type Body =
  | { intent: "aura_pack"; townSlug: string; amountCents: number }
  | { intent: "aura_upgrade"; townSlug: string; amountCents: number }
  | { intent: "town_slot" };

export async function POST(req: Request) {
  if (!isPricingEnabled()) {
    return NextResponse.json({ error: "pricing-disabled" }, { status: 403 });
  }

  const session = await getSessionFromCookie();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }

  const origin = new URL(req.url).origin;
  const stripe = getStripe();

  if (body.intent === "aura_pack") {
    const tier = AURA_TIERS.find((t) => t.cents === body.amountCents);
    if (!tier) {
      return NextResponse.json({ error: "bad-tier" }, { status: 400 });
    }
    const town = await prisma.town.findUnique({
      where: { slug: body.townSlug },
      select: { id: true, name: true, ownerId: true },
    });
    if (!town) return NextResponse.json({ error: "town-not-found" }, { status: 404 });
    if (town.ownerId !== session.user.id) {
      return NextResponse.json({ error: "not-owner" }, { status: 403 });
    }

    const metadata: CheckoutMetadata = {
      intent: "aura_pack",
      userId: session.user.id,
      townId: town.id,
      auraAmount: String(tier.aura),
    };

    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Aura top-up · ${tier.aura.toLocaleString()} aura`,
              description: `For ${town.name}`,
            },
            unit_amount: tier.cents,
          },
          quantity: 1,
        },
      ],
      metadata: metadata as unknown as Record<string, string>,
      success_url: `${origin}/${body.townSlug}?stripe=success`,
      cancel_url: `${origin}/${body.townSlug}?stripe=cancel`,
    });

    return NextResponse.json({ url: checkout.url });
  }

  if (body.intent === "aura_upgrade") {
    const tier = AURA_UPGRADES.find((t) => t.cents === body.amountCents);
    if (!tier) {
      return NextResponse.json({ error: "bad-tier" }, { status: 400 });
    }
    const town = await prisma.town.findUnique({
      where: { slug: body.townSlug },
      select: { id: true, name: true, ownerId: true },
    });
    if (!town) return NextResponse.json({ error: "town-not-found" }, { status: 404 });
    if (town.ownerId !== session.user.id) {
      return NextResponse.json({ error: "not-owner" }, { status: 403 });
    }

    const metadata: CheckoutMetadata = {
      intent: "aura_upgrade",
      userId: session.user.id,
      townId: town.id,
      newMax: String(tier.newMax),
    };

    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Aura cap upgrade · ${tier.newMax.toLocaleString()} max`,
              description: `Permanent upgrade for ${town.name}`,
            },
            unit_amount: tier.cents,
          },
          quantity: 1,
        },
      ],
      metadata: metadata as unknown as Record<string, string>,
      success_url: `${origin}/${body.townSlug}?stripe=success`,
      cancel_url: `${origin}/${body.townSlug}?stripe=cancel`,
    });

    return NextResponse.json({ url: checkout.url });
  }

  if (body.intent === "town_slot") {
    const metadata: CheckoutMetadata = {
      intent: "town_slot",
      userId: session.user.id,
    };
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Extra town slot" },
            unit_amount: TOWN_SLOT_CENTS,
          },
          quantity: 1,
        },
      ],
      metadata: metadata as unknown as Record<string, string>,
      success_url: `${origin}/?stripe=success`,
      cancel_url: `${origin}/?stripe=cancel`,
    });

    return NextResponse.json({ url: checkout.url });
  }

  return NextResponse.json({ error: "bad-intent" }, { status: 400 });
}

/** Exposed so the client can render the correct tier prices without
 *  re-encoding constants twice. Not gated on pricing so a disabled
 *  build still returns the shape for potential debug pages. */
export function GET() {
  return NextResponse.json({
    auraTiers: AURA_TIERS,
    auraUpgrades: AURA_UPGRADES,
    townSlotCents: TOWN_SLOT_CENTS,
    pricingEnabled: isPricingEnabled(),
  });
}
