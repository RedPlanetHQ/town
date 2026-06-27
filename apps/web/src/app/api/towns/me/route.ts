// /api/towns/me
//
//   GET  → { town: { id, slug, name } | null }
//   POST { name, slug? } → { town: { id, slug, name } } on success;
//        4xx with { error: 'slug-taken' | 'slug-invalid' }
//
// Accepts both the browser session cookie and a CORE PAT
// (Authorization: Bearer <pat>), so `town init` can check ownership +
// onboard a fresh town from the CLI without going through the web UI.
//
// Multi-town: a user can own N towns now. POST always creates a new
// town; GET returns the OLDEST owned town for backward-compat.

import { NextResponse } from "next/server";

import { resolveUser } from "@/lib/auth-bearer";
import { getTownsByOwner, pickTown } from "@/lib/town";

export async function GET(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Backward-compat: return the oldest owned town as `town`, or null.
  const towns = await getTownsByOwner(resolved.user.id);
  const oldest = towns.length > 0 ? towns[towns.length - 1] : null;
  return NextResponse.json({
    town: oldest
      ? { id: oldest.id, slug: oldest.slug, name: oldest.name }
      : null,
  });
}

export async function POST(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { name?: string; slug?: string };
  try {
    body = (await req.json()) as { name?: string; slug?: string };
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  if (!body.name || typeof body.name !== "string") {
    return NextResponse.json({ error: "missing-name" }, { status: 400 });
  }

  try {
    const town = await pickTown({
      ownerId: resolved.user.id,
      name: body.name,
      slug: body.slug,
    });
    return NextResponse.json({
      town: { id: town.id, slug: town.slug, name: town.name },
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "slug-taken" || code === "slug-invalid") {
      return NextResponse.json({ error: code }, { status: 409 });
    }
    console.error("[towns/me POST] unexpected", e);
    return NextResponse.json({ error: "server-error" }, { status: 500 });
  }
}
