// Feature flag for the whole payments / Stripe stack.
//
// Server-only env. When unset (or anything other than "true"), the
// Buy-aura and Buy-town-slot menu items don't render, and the
// checkout API returns 403. The Stripe webhook stays live either way
// so an in-flight session from a prior on-state can still be granted
// after the flag flips.
//
// Read this from server components / route handlers and pass the
// resolved boolean down to client components as a prop. Never read
// `process.env` in a client module — bundlers won't inline this
// value, and we don't want to leak the env var name into the client
// bundle just to gate a UI affordance.
//
// Toggle by setting `PRICING_ENABLED=true` in the deployed env.

export function isPricingEnabled(): boolean {
  return process.env.PRICING_ENABLED === "true";
}
