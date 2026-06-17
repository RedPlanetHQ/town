// Per-author name color in the group chat overlay.
//
// We want the same person to render in the same color across messages,
// across refreshes, and across both sides of a multi-participant chat —
// so the hue is derived deterministically from `authorKey` (which is
// stable for humans, guests, and NPCs alike). No random component.
//
// Lightness + chroma are pinned to values that read well on the cream
// surface background. Hue is constrained to 30–360 so we skip the
// red-orange band that the in-game error styles already own.

const LIGHTNESS = 66;
const CHROMA = 0.1835;

/** Cheap FNV-1a 32-bit hash. We just need stable, well-distributed
 *  integers per author key — not cryptographic strength. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Hash an author key to a stable OKLCH string. */
export function authorColor(authorKey: string): string {
  // Map the 32-bit hash into the 30–360 hue band.
  const hue = 30 + (hash32(authorKey) % (360 - 30 + 1));
  return `oklch(${LIGHTNESS}% ${CHROMA} ${hue})`;
}
