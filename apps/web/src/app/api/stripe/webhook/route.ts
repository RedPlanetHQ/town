// POST /api/stripe/webhook — Stripe webhook receiver.
//
// Verifies signature, then hands off to the grant router. Runs even
// when `PRICING_ENABLED` is off, so a session started while the flag
// was on can still be granted after it flips.

import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { applyStripeGrant } from "@/lib/billing/grants";
import { getStripe, getWebhookSecret, type CheckoutMetadata } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "no-signature" }, { status: 400 });

  const rawBody = await req.text();
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, getWebhookSecret());
  } catch (err) {
    console.warn("[stripe-webhook] signature check failed", err);
    return NextResponse.json({ error: "bad-signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const metadata = s.metadata as unknown as CheckoutMetadata | null;
        if (!metadata?.intent) {
          console.warn("[stripe-webhook] session missing metadata.intent", s.id);
          break;
        }
        if ((s.amount_total ?? 0) <= 0) {
          console.warn("[stripe-webhook] session has zero amount", s.id);
          break;
        }
        if (s.payment_status !== "paid") {
          // Ignore async payments that haven't settled yet; they'll fire
          // `checkout.session.async_payment_succeeded` when they do.
          break;
        }
        await applyStripeGrant({
          metadata,
          amountCents: s.amount_total ?? 0,
          stripeSessionId: s.id,
        });
        break;
      }
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object as Stripe.Checkout.Session;
        const metadata = s.metadata as unknown as CheckoutMetadata | null;
        if (!metadata?.intent) break;
        await applyStripeGrant({
          metadata,
          amountCents: s.amount_total ?? 0,
          stripeSessionId: s.id,
        });
        break;
      }
      default:
        // Ignore other event types. Stripe replays until we ack.
        break;
    }
  } catch (err) {
    console.error("[stripe-webhook] handler failed", err);
    return NextResponse.json({ error: "handler-failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
