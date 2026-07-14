// Shared Stripe client. Lazy-initialized so the app boots without
// `STRIPE_SECRET_KEY` set when pricing is disabled — throws only if
// something actually tries to call Stripe with the flag off.

import Stripe from "stripe";

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set — cannot call Stripe");
  }
  cached = new Stripe(key);
  return cached;
}

export function getWebhookSecret(): string {
  const s = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return s;
}

/** Shape of what the checkout API stashes in `session.metadata`.
 *  The webhook re-parses this and routes to a grant handler.
 *
 *  For aura_pack we encode the concrete `auraAmount` per tier rather
 *  than a `ratePerDollar` — pricing is tiered (bigger buys get better
 *  rates) so the amount isn't a linear function of the dollar figure. */
export type CheckoutMetadata =
  | { intent: "aura_pack"; userId: string; townId: string; auraAmount: string }
  | { intent: "aura_upgrade"; userId: string; townId: string; newMax: string }
  | { intent: "town_slot"; userId: string };
