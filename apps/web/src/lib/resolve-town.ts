// Slug-resolution helper shared by every route handler that targets a
// single town owned by the caller. Triage in priority order:
//   1. ?slug=<x> present → look up by slug, gate on ownership.
//   2. Otherwise → check the active-slug cookie set on every /{slug}
//      visit by proxy.ts. If it points at one of the caller's owned
//      towns, use it.
//   3. Otherwise → list the caller's towns; 0 → no-towns, 1 → that
//      one, N → missing-slug with the list.
//
// The cookie fallback matters because client-side fetches from
// /{slug} pages don't always carry ?slug=, but the cookie does carry
// the active context. Without it, multi-town owners hit missing-slug
// errors for every endpoint that uses this helper (Invite, ShareImage,
// suggestions, etc.) and the UI silently breaks.
//
// The result is consumed as a discriminated union so handlers can
// short-circuit on the failure variant with one NextResponse.json call.

import { readActiveSlug } from "./active-slug";
import { getTownBySlug, getTownsByOwner } from "./town";

export type SlugResolution =
  | { ok: true; townId: string; slug: string }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function resolveTownForOwner(
  req: Request,
  ownerId: string,
): Promise<SlugResolution> {
  const url = new URL(req.url);
  const explicit = url.searchParams.get("slug");
  if (explicit) {
    const town = await getTownBySlug(explicit);
    if (!town || town.ownerId !== ownerId) {
      return { ok: false, status: 404, body: { error: "town-not-found" } };
    }
    return { ok: true, townId: town.id, slug: town.slug };
  }
  const owned = await getTownsByOwner(ownerId);
  if (owned.length === 0) {
    return { ok: false, status: 404, body: { error: "no-towns" } };
  }
  if (owned.length === 1) {
    return { ok: true, townId: owned[0]!.id, slug: owned[0]!.slug };
  }
  // Multi-town: cookie fallback before failing.
  const activeSlug = await readActiveSlug();
  if (activeSlug) {
    const match = owned.find((t) => t.slug === activeSlug);
    if (match) return { ok: true, townId: match.id, slug: match.slug };
  }
  return {
    ok: false,
    status: 400,
    body: { error: "missing-slug", slugs: owned.map((t) => t.slug) },
  };
}
