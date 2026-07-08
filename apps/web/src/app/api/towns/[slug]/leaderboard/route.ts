// GET /api/towns/[slug]/leaderboard
//
// Per-town visitor leaderboard. Aggregates VisitorItem + VisitorTag
// counts by subjectKey for this one town, joins the latest denormalized
// display name from TownActivity, and returns the top N ranked by
// (items + tags) descending.
//
// Auth: resolveViewer — any owner or visitor holding a valid share-code
// cookie for this town can read it. Same policy as the items endpoint.
//
// Caching: no-store. NPCs award items/tags in real time and the UI
// re-fetches when the popover opens; a stale cache would misreport
// scores by a full poll window.

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { resolveViewer } from "@/lib/viewer";

type Params = { slug: string };

const MAX_ROWS = 100;

interface Row {
  subjectKey: string;
  name: string;
  character: string | null;
  itemCount: number;
  tagCount: number;
  score: number;
}

export async function GET(_req: Request, ctx: { params: Promise<Params> }) {
  const { slug } = await ctx.params;
  const view = await resolveViewer(slug);
  if ("error" in view) {
    return NextResponse.json(
      { error: view.error },
      { status: view.error === "not-found" ? 404 : 403 },
    );
  }

  const [items, tags] = await Promise.all([
    prisma.visitorItem.groupBy({
      by: ["subjectKey"],
      where: { townSlug: slug },
      _count: { _all: true },
    }),
    prisma.visitorTag.groupBy({
      by: ["subjectKey"],
      where: { townSlug: slug },
      _count: { _all: true },
    }),
  ]);

  const byKey = new Map<string, { items: number; tags: number }>();
  for (const it of items) {
    const row = byKey.get(it.subjectKey) ?? { items: 0, tags: 0 };
    row.items = it._count._all;
    byKey.set(it.subjectKey, row);
  }
  for (const tg of tags) {
    const row = byKey.get(tg.subjectKey) ?? { items: 0, tags: 0 };
    row.tags = tg._count._all;
    byKey.set(tg.subjectKey, row);
  }

  const keys = Array.from(byKey.keys());
  if (keys.length === 0) {
    return NextResponse.json(
      { rows: [] },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // Latest denormalized name + character per subjectKey. TownActivity
  // is written on every award and visit, so this reliably surfaces the
  // most recent display name the visitor picked at the gate — and, for
  // signed-in users, the current CORE display name.
  const activity = await prisma.townActivity.findMany({
    where: { townSlug: slug, subjectKey: { in: keys } },
    select: {
      subjectKey: true,
      subjectName: true,
      subjectCharacter: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  const identityByKey = new Map<
    string,
    { name: string; character: string | null }
  >();
  for (const a of activity) {
    if (!identityByKey.has(a.subjectKey)) {
      identityByKey.set(a.subjectKey, {
        name: a.subjectName,
        character: a.subjectCharacter,
      });
    }
  }

  const rows: Row[] = Array.from(byKey.entries())
    .map(([key, counts]) => {
      const ident = identityByKey.get(key);
      return {
        subjectKey: key,
        // Fallback to the raw id suffix when we have no activity row for
        // this subject (shouldn't normally happen — awards emit activity
        // — but keeps the row from rendering blank).
        name: ident?.name ?? key.replace(/^(user|guest):/, ""),
        character: ident?.character ?? null,
        itemCount: counts.items,
        tagCount: counts.tags,
        score: counts.items + counts.tags,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ROWS);

  return NextResponse.json(
    { rows },
    { headers: { "cache-control": "no-store" } },
  );
}
