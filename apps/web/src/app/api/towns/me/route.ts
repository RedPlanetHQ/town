// /api/towns/me
//
//   POST { name, slug? } → { town: { id, slug, name } } on success;
//        4xx with { error: 'slug-taken' | 'slug-invalid' }
//
// Accepts both the browser session cookie and a CORE PAT
// (Authorization: Bearer <pat>), so `town new` can create a town from
// the CLI without going through the web UI.
//
// GET was removed in the multi-town sweep — it returned the OLDEST
// owned town, which silently picked the wrong town for multi-town
// owners. Every client UI that used it (Invite, ShareImage, Flyover)
// now takes the active slug as a prop, and the CLI never called GET.
// Multi-town clients hit /api/towns/mine for the full list, or
// /api/towns/<slug>/* for a specific town.

import { NextResponse } from "next/server";

import { resolveUser } from "@/lib/auth-bearer";
import { pickTown } from "@/lib/town";

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
