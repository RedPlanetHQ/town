// /api/towns/[slug]/visibility
//
//   GET   → { isPublic }                    (owner only)
//   PATCH → body { isPublic } → { isPublic } (owner only; toggles listing)
//
// Owner opt-in flag for the public /explore leaderboard. When true the
// town appears on /explore and its share code is embedded in the row
// link (so any visitor can enter without knowing the code up front).
// When false the town behaves as before — invite-only via share code.

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getSessionFromCookie } from "@/lib/session";
import { getTownBySlug } from "@/lib/town";

type Params = { slug: string };

async function requireOwnerTown(slug: string) {
  const session = await getSessionFromCookie();
  if (!session) return { error: "unauthorized" as const, status: 401 };
  const town = await getTownBySlug(slug);
  if (!town) return { error: "not-found" as const, status: 404 };
  if (town.ownerId !== session.user.id) {
    return { error: "forbidden" as const, status: 403 };
  }
  return { town };
}

export async function GET(_req: Request, ctx: { params: Promise<Params> }) {
  const { slug } = await ctx.params;
  const result = await requireOwnerTown(slug);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ isPublic: result.town.isPublic });
}

export async function PATCH(req: Request, ctx: { params: Promise<Params> }) {
  const { slug } = await ctx.params;
  const result = await requireOwnerTown(slug);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  let body: { isPublic?: boolean };
  try {
    body = (await req.json()) as { isPublic?: boolean };
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  if (typeof body.isPublic !== "boolean") {
    return NextResponse.json({ error: "missing-isPublic" }, { status: 400 });
  }

  const updated = await prisma.town.update({
    where: { id: result.town.id },
    data: { isPublic: body.isPublic },
    select: { isPublic: true },
  });
  return NextResponse.json({ isPublic: updated.isPublic });
}
