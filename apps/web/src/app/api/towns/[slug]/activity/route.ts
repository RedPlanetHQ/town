// GET /api/towns/[slug]/activity?limit=50
//
// Returns the newest TownActivity rows for this town. Read by the FEED
// panel in /{slug}, which polls every ~20s while open.
//
// Auth: none. Activity entries are public — they only contain data the
// visitor would already see in-world (display name, sprite, building
// label, NPC name, tag id). Gating this would just mean every visitor
// needs a session before they could see the feed they already see.
//
// Caching: no-store; the feed turns over too often for any shared
// caching strategy to pay off.

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import type { TownActivityKind } from "@/lib/town-activity";

type Params = { slug: string };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

interface ActivityWire {
  id: string;
  kind: TownActivityKind;
  subjectKey: string;
  subjectName: string;
  subjectCharacter: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export async function GET(req: Request, ctx: { params: Promise<Params> }) {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(
    Math.max(Number.isFinite(requested) ? requested : DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  const rows = await prisma.townActivity.findMany({
    where: { townSlug: slug },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const items: ActivityWire[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind as TownActivityKind,
    subjectKey: row.subjectKey,
    subjectName: row.subjectName,
    subjectCharacter: row.subjectCharacter,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
  }));

  return NextResponse.json(
    { items },
    { headers: { "cache-control": "no-store" } },
  );
}
