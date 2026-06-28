// GET /api/towns/[slug]/aura
// Public — anyone who can see the town can read its aura meter. Returns
// just `{ current, max }`; mirrors the values stored on the Aura row.
// The hourly aura-regen cron updates the row in place, so this read
// reflects the most recent tick without any compute on the read path.

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getTownBySlug } from "@/lib/town";

type Params = { slug: string };

export async function GET(_req: Request, ctx: { params: Promise<Params> }) {
  const { slug } = await ctx.params;
  const town = await getTownBySlug(slug);
  if (!town) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  const aura = await prisma.aura.findUnique({
    where: { townId: town.id },
    select: { current: true, max: true },
  });
  if (!aura) {
    // Every Town has an Aura row by invariant (created in the same tx).
    // If a stray legacy town slipped through, surface the absence so we
    // notice rather than silently zeroing the meter.
    return NextResponse.json({ error: "aura-missing" }, { status: 500 });
  }
  return NextResponse.json({ current: aura.current, max: aura.max });
}
