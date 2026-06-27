// Slug-resolution helper shared by every route handler that targets a
// single town owned by the caller. Implements the same triage every
// route used to inline:
//   1. ?slug=<x> present → look up by slug, gate on ownership.
//   2. Otherwise → list the caller's towns; 0 → no-towns, 1 → that one,
//      N → missing-slug with the list.
// The result is consumed as a discriminated union so handlers can
// short-circuit on the failure variant with one NextResponse.json call.

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
  if (owned.length > 1) {
    return {
      ok: false,
      status: 400,
      body: { error: "missing-slug", slugs: owned.map((t) => t.slug) },
    };
  }
  return { ok: true, townId: owned[0]!.id, slug: owned[0]!.slug };
}
