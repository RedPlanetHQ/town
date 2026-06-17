// Sprite reference resolution. A sprite ref inside a Plot or CustomPlot
// can take one of two shapes by the time it reaches the runtime:
//
//   • "sprite:<contentHash>"  — uploaded user art, served from the
//     /api/sprites/<hash>.png route the webapp exposes.
//   • "exteriors/foo.png"     — a catalog-relative path, served from the
//     static /sprites/catalog/ tree shipped with the webapp.
//
// Local "./foo.png" refs never reach the runtime — the CLI uploads
// those during `town deploy` and rewrites them to "sprite:<hash>".

import type { SpriteRef } from "./types";

/** True for refs that point at an uploaded blob. */
export function isUploadedSpriteRef(ref: SpriteRef): boolean {
  return ref.startsWith("sprite:");
}

/** Extract the content hash from an uploaded ref, or null if it isn't one. */
export function uploadedSpriteHash(ref: SpriteRef): string | null {
  return isUploadedSpriteRef(ref) ? ref.slice("sprite:".length) : null;
}

/** Resolve a sprite ref into a URL the renderer can pass to an <img>.
 *
 *  - `sprite:<hash>` → `/api/sprites/<hash>.png`
 *  - anything else   → `/sprites/catalog/<ref>` (the legacy catalog path)
 *
 *  Callers can override the prefixes when serving from a non-default
 *  origin (CLI previews, tests). */
export function resolveSpriteUrl(
  ref: SpriteRef,
  opts: { catalogBase?: string; uploadBase?: string } = {},
): string {
  const hash = uploadedSpriteHash(ref);
  if (hash) {
    const base = opts.uploadBase ?? "/api/sprites";
    return `${base}/${hash}.png`;
  }
  const base = opts.catalogBase ?? "/sprites/catalog";
  return `${base}/${ref}`;
}
