// Feature flag for the whole payments / Stripe stack.
//
// When `NEXT_PUBLIC_PRICING_ENABLED` is unset (or anything other than
// "true"), the Buy-aura and Buy-town-slot menu items don't render, and
// the checkout API returns 403. The Stripe webhook stays live either
// way so an in-flight session from a prior on-state can still be
// granted after the flag flips.
//
// The `NEXT_PUBLIC_` prefix is intentional: this is a UI toggle, not a
// secret, and Next inlines the value into the client bundle so the
// dropdown can hide the items with no round-trip.
//
// Toggle by setting `NEXT_PUBLIC_PRICING_ENABLED=true` in the deployed env.

export function isPricingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PRICING_ENABLED === "true";
}
