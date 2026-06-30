// /api/npcs — read a user's NPC roster.
//
//   GET  /api/npcs                     → { npcs: Npc[] }   (signed-in user's own)
//   GET  /api/npcs?town=<slug>         → { npcs: Npc[] }   (that town's NPCs;
//                                                            owner OR valid
//                                                            visitor-cookie holder)
//
// Accepts either a session cookie (browser) or a CORE PAT
// (Authorization: Bearer <pat>). `?town=<slug>` is the primary surface;
// the bare path falls back to the caller's active-slug cookie before
// any town-disambiguation heuristic.
//
// POST was removed in the multi-town sweep — `town deploy` consolidated
// into `/api/town` POST a long time ago, and the old "fall back to
// most-recently-updated town" code would silently nuke and replace the
// wrong town's roster for any future caller that hit this path.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { readActiveSlug } from "@/lib/active-slug";
import { resolveUser } from "@/lib/auth-bearer";
import { prisma } from "@/lib/db";
import { ensureNpcsForTown } from "@/lib/plot";
import { getTownBySlug } from "@/lib/town";
import { parseVisitorCookie, visitorCookieName } from "@/lib/town-code";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const townSlug = url.searchParams.get("town");

  // Visitor / cross-town read. Mirrors /api/plot's gating: the town owner
  // gets through automatically, anyone else needs a per-slug visitor
  // cookie carrying the current share code.
  if (townSlug) {
    const town = await getTownBySlug(townSlug);
    if (!town) {
      return NextResponse.json({ error: "not-found" }, { status: 404 });
    }
    const resolved = await resolveUser(req);
    const isOwner = !!resolved && resolved.user.id === town.ownerId;
    if (!isOwner) {
      const jar = await cookies();
      const cookie = parseVisitorCookie(jar.get(visitorCookieName(townSlug))?.value);
      if (!cookie || cookie.c !== town.shareCode) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
    // Backfill on read so towns whose plot pre-dates the Npc table
    // still get a roster on first visit.
    await ensureNpcsForTown(town.id);
    const rows = await prisma.npc.findMany({
      where: { townId: town.id },
      orderBy: { buildingId: "asc" },
    });
    return NextResponse.json({
      npcs: rows.map((r) => ({
        id: r.id,
        buildingId: r.buildingId,
        slotId: r.slotId,
        name: r.name,
        description: r.description,
        prompt: r.prompt,
      })),
    });
  }

  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // No `?town=` query → prefer the active-slug cookie (which the proxy
  // writes on every /{slug} visit) so multi-town owners get the town
  // they're currently viewing. Falls back to the most-recently-updated
  // town only when no cookie is present, e.g. CLI hits before the
  // browser ever visited the new town.
  let ownTown: { id: string } | null = null;
  const activeSlug = await readActiveSlug();
  if (activeSlug) {
    const cookieTown = await prisma.town.findFirst({
      where: { slug: activeSlug, ownerId: resolved.user.id },
      select: { id: true },
    });
    if (cookieTown) ownTown = cookieTown;
  }
  if (!ownTown) {
    ownTown = await prisma.town.findFirst({
      where: { ownerId: resolved.user.id },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
  }
  if (!ownTown) {
    return NextResponse.json({ npcs: [] });
  }
  await ensureNpcsForTown(ownTown.id);
  const rows = await prisma.npc.findMany({
    where: { townId: ownTown.id },
    orderBy: [{ buildingId: "asc" }, { slotId: "asc" }],
  });
  return NextResponse.json({
    npcs: rows.map((r) => ({
      id: r.id,
      buildingId: r.buildingId,
      slotId: r.slotId,
      name: r.name,
      description: r.description,
      prompt: r.prompt,
    })),
  });
}

