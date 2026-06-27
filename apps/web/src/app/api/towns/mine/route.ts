// /api/towns/mine
//
//   GET → { towns: [...], activeSlug }
//
// Owner is read from session or PAT. The list is implicitly
// workspace-scoped: a session belongs to one town-next User row,
// which belongs to one CORE workspace.

import { NextResponse } from "next/server";

import { resolveUser } from "@/lib/auth-bearer";
import { readActiveSlug } from "@/lib/active-slug";
import { getTownsByOwner } from "@/lib/town";

export async function GET(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const towns = await getTownsByOwner(resolved.user.id);
  const activeSlug = await readActiveSlug();
  return NextResponse.json({
    towns: towns.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      updatedAt: t.updatedAt,
      aura: t.aura
        ? { current: t.aura.current, max: t.aura.max }
        : { current: 1000, max: 1000 },
    })),
    activeSlug,
  });
}
