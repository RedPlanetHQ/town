// Client-side aura pub-sub.
//
// TownGame polls /api/towns/<slug>/aura every ~5 minutes and pushes the
// result here so both React (for the low-light overlay) and kaplay (for
// the sleepy 💤 above each NPC) can react to the same value without
// each surface owning its own poller.
//
// When the town's `current` aura drops below AURA_SLEEP_THRESHOLD the
// server also refuses new NPC chat turns — see token-usage.ts for the
// shared constant.

export type Aura = { current: number; max: number };

let current: Aura | null = null;
const listeners = new Set<() => void>();

/** Threshold below which the town is "sleeping" — NPCs go quiet and
 *  the client shows the low-light overlay. Kept in sync with
 *  AURA_SLEEP_THRESHOLD on the server side. */
export const CLIENT_AURA_SLEEP_THRESHOLD = 100;

export function setAura(next: Aura | null): void {
  // Cheap identity check — polling the same values shouldn't kick off
  // re-renders across every subscriber.
  if (
    next === current ||
    (next &&
      current &&
      next.current === current.current &&
      next.max === current.max)
  ) {
    return;
  }
  current = next;
  for (const l of listeners) l();
}

export function getAura(): Aura | null {
  return current;
}

/** True iff the last poll observed aura below CLIENT_AURA_SLEEP_THRESHOLD.
 *  Returns false when we've never polled (null current) so the first
 *  boot doesn't flash the sleeping overlay. */
export function isSleeping(): boolean {
  return current !== null && current.current < CLIENT_AURA_SLEEP_THRESHOLD;
}

export function onAuraChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
