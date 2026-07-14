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

const AURA_TIERS_CENTS = [500, 1000, 2500] as const;    // $5 / $10 / $25
const AURA_RATE_PER_DOLLAR = 1000;                       // 1000 aura per USD
const TOWN_SLOT_CENTS = 1000;                            // $10 for +1 slot

type Body =
  | { intent: "aura_pack"; townSlug: string; amountCents: number }
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
    if (!AURA_TIERS_CENTS.includes(body.amountCents as (typeof AURA_TIERS_CENTS)[number])) {
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
      ratePerDollar: String(AURA_RATE_PER_DOLLAR),
    };

    const auraAmount = Math.floor((body.amountCents / 100) * AURA_RATE_PER_DOLLAR);

    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Aura top-up · ${auraAmount.toLocaleString()} aura`,
              description: `For ${town.name}`,
            },
            unit_amount: body.amountCents,
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
    auraTiersCents: AURA_TIERS_CENTS,
    auraRatePerDollar: AURA_RATE_PER_DOLLAR,
    townSlotCents: TOWN_SLOT_CENTS,
    pricingEnabled: isPricingEnabled(),
  });
}
