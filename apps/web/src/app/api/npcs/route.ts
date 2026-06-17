// /api/npcs — read + bulk-replace a user's NPC roster.
//
//   GET  /api/npcs                     → { npcs: Npc[] }   (signed-in user's own)
//   GET  /api/npcs?town=<slug>         → { npcs: Npc[] }   (that town's NPCs;
//                                                            owner OR valid
//                                                            visitor-cookie holder)
//   POST /api/npcs { npcs: Npc[] }     → { count }       (replaces wholesale)
//
// Both routes accept either a session cookie (browser) or a CORE PAT
// (Authorization: Bearer <pat>, used by the `town` CLI). POST always
// writes the caller's own NPCs — `?town` only gates reads.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveUser } from "@/lib/auth-bearer";
import { prisma } from "@/lib/db";
import { ensureNpcsForUser } from "@/lib/plot";
import { getTownBySlug } from "@/lib/town";
import { parseVisitorCookie, visitorCookieName } from "@/lib/town-code";

const NpcUpsertSchema = z.object({
  buildingId: z.string().min(1),
  // Slot within the building. Empty string is the implicit first slot.
  slotId: z.string().default(""),
  name: z.string().min(1),
  description: z.string(),
  prompt: z.string(),
  // Optional — when an existing row's id is included we preserve it,
  // otherwise a fresh cuid is generated.
  id: z.string().optional(),
});

const PostBodySchema = z.object({
  npcs: z.array(NpcUpsertSchema),
});

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
    // Backfill on read so users whose plot pre-dates the Npc table
    // still get a roster on first visit.
    await ensureNpcsForUser(town.ownerId);
    const rows = await prisma.npc.findMany({
      where: { userId: town.ownerId },
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
  await ensureNpcsForUser(resolved.user.id);
  const rows = await prisma.npc.findMany({
    where: { userId: resolved.user.id },
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

export async function POST(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let parsed;
  try {
    parsed = PostBodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: "bad-request", detail: e instanceof Error ? e.message : "invalid body" },
      { status: 400 },
    );
  }

  // Replace wholesale inside a transaction so a partial write is impossible.
  // CLI `town deploy` will use this — the user's local .mdx files are the
  // source of truth and the server mirrors them on push.
  const userId = resolved.user.id;
  const count = await prisma.$transaction(async (tx) => {
    await tx.npc.deleteMany({ where: { userId } });
    if (parsed.npcs.length === 0) return 0;
    const created = await tx.npc.createMany({
      data: parsed.npcs.map((n) => ({
        ...(n.id ? { id: n.id } : {}),
        userId,
        buildingId: n.buildingId,
        slotId: n.slotId,
        name: n.name,
        description: n.description,
        prompt: n.prompt,
      })),
    });
    return created.count;
  });

  return NextResponse.json({ count });
}
