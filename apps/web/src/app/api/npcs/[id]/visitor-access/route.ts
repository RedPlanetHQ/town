// /api/npcs/[id]/visitor-access — a signed-in VISITOR manages the grants of
// their OWN CORE integrations to this NPC. Feeds the in-chat
// access popover.
//
//   GET  → { needed, connected, granted }
//          needed    = integration slugs this NPC is configured to use (mdx)
//          connected = which of those the visitor has connected in CORE
//                      (their own accounts, fetched with the visitor's token)
//          granted   = slugs the visitor has already granted this NPC
//   PUT  { slugs } → replace the visitor's grant set (upsert + revoke diff)
//   DELETE         → revoke everything the visitor granted this NPC
//
// Auth: resolveViewer against the NPC's town. Must be a SIGNED-IN visitor
// (a User row) — anonymous guests have no CORE account to lend, so they get
// 401 and the UI sends them through CORE sign-in first. The owner path is
// unaffected; owners grant their own accounts via mdx, not here.

import { NextResponse } from "next/server";

import { getCoreToken } from "@/lib/core-token";
import { prisma } from "@/lib/db";
import {
  loadActiveVisitorGrants,
  replaceVisitorGrants,
  revokeAllVisitorGrants,
} from "@/lib/visitor-grants";
import { resolveViewer } from "@/lib/viewer";

const CORE_BASE = () => process.env.CORE_OAUTH_BASE;

/** Pull the integration slugs an NPC is configured to use out of its
 *  permissions blob (the owner-authored mdx grant). These are the slugs a
 *  visitor may be asked to lend their own account for. */
function neededSlugs(permissions: unknown): string[] {
  const p = permissions as { integrations?: Array<{ slug?: unknown }> } | null;
  if (!p || !Array.isArray(p.integrations)) return [];
  return p.integrations
    .map((g) => (typeof g?.slug === "string" ? g.slug : null))
    .filter((s): s is string => !!s);
}

async function loadNpcWithTown(npcId: string) {
  return prisma.npc.findUnique({
    where: { id: npcId },
    include: { town: { select: { id: true, slug: true } } },
  });
}
type NpcWithTown = NonNullable<Awaited<ReturnType<typeof loadNpcWithTown>>>;

// Discriminated result. We narrow on `ok` rather than `"error" in resolved`:
// with an inferred union the `in` check widens `resolved.error` to include
// `undefined`, which then isn't assignable to errBody's status type.
type ResolvedNpcViewer =
  | { ok: false; status: 401 | 403 | 404 }
  | {
      ok: true;
      npc: NpcWithTown;
      visitorUserId: string | null;
      isOwner: boolean;
    };

/** Load the NPC and resolve the caller against its town. Requires being IN
 *  the town (owner session or a valid visit cookie) but NOT sign-in — GET is
 *  readable by anyone in the town so an anonymous guest can see the button and
 *  get prompted to sign in; PUT/DELETE gate on `visitorUserId`.
 *  The owner grants integrations via mdx, not this popover, so we treat them
 *  as a non-granter: `visitorUserId` is null for the owner too, and `isOwner`
 *  lets the UI hide the button. Only a signed-in visitor gets an id. */
async function resolveNpcAndViewer(npcId: string): Promise<ResolvedNpcViewer> {
  const npc = await loadNpcWithTown(npcId);
  if (!npc) return { ok: false, status: 404 };

  const view = await resolveViewer(npc.town.slug);
  if ("error" in view) {
    return { ok: false, status: view.error === "not-found" ? 404 : 403 };
  }
  return {
    ok: true,
    npc,
    visitorUserId: view.isOwner ? null : view.userId,
    isOwner: view.isOwner,
  };
}

function errBody(status: 401 | 403 | 404) {
  return status === 401
    ? "unauthorized"
    : status === 403
      ? "forbidden"
      : "not-found";
}

/** The visitor's own connected integrations (slug + name + account id),
 *  fetched with THEIR token. Empty on any CORE hiccup — the UI degrades to
 *  "nothing connected" rather than erroring. */
async function fetchVisitorIntegrations(
  token: string,
): Promise<
  Array<{ slug: string; name: string; integration_account_id: string }>
> {
  const base = CORE_BASE();
  if (!base) return [];
  const res = await fetch(`${base}/api/v1/integration_account`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.warn(`[visitor-access] CORE ${res.status} listing accounts`);
    return [];
  }
  const data = (await res.json()) as {
    accounts?: Array<{
      id?: string;
      integrationDefinition?: { slug?: string; name?: string };
    }>;
  };
  return (data.accounts ?? [])
    .filter(
      (a) =>
        typeof a.id === "string" &&
        typeof a.integrationDefinition?.slug === "string",
    )
    .map((a) => ({
      slug: a.integrationDefinition!.slug!,
      name: a.integrationDefinition!.name ?? a.integrationDefinition!.slug!,
      integration_account_id: a.id!,
    }));
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const resolved = await resolveNpcAndViewer(id);
  if (!resolved.ok) {
    return NextResponse.json(
      { error: errBody(resolved.status) },
      { status: resolved.status },
    );
  }
  const { npc, visitorUserId, isOwner } = resolved;
  const signedIn = !!visitorUserId;
  const needed = neededSlugs(npc.permissions);

  // Owner (grants via mdx, not here), anonymous guest, or an NPC with no
  // integrations: nothing to grant. `isOwner` tells the UI to hide the button;
  // a non-owner guest instead gets prompted to sign in.
  if (isOwner || !signedIn || needed.length === 0) {
    return NextResponse.json({
      needed,
      connected: [],
      granted: [],
      signedIn,
      isOwner,
    });
  }

  const granted = (await loadActiveVisitorGrants(npc.id, visitorUserId)).map(
    (g) => g.slug,
  );

  const token = await getCoreToken(req);
  if (!token) {
    // Signed-in but no live CORE token (session lapsed) — grants read-only.
    return NextResponse.json({
      needed,
      connected: [],
      granted,
      signedIn,
      isOwner,
      warning: "core-unavailable",
    });
  }

  const neededSet = new Set(needed);
  const connected = (await fetchVisitorIntegrations(token)).filter((c) =>
    neededSet.has(c.slug),
  );
  return NextResponse.json({ needed, connected, granted, signedIn, isOwner });
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const resolved = await resolveNpcAndViewer(id);
  if (!resolved.ok) {
    return NextResponse.json(
      { error: errBody(resolved.status) },
      { status: resolved.status },
    );
  }
  const { npc, visitorUserId } = resolved;
  // Granting needs the visitor's own CORE account → sign-in required.
  if (!visitorUserId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { slugs?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }
  const requested = Array.isArray(body.slugs)
    ? body.slugs.filter((s): s is string => typeof s === "string")
    : [];

  // A visitor may only grant slugs the NPC actually declares. Anything else
  // is dropped — a grant the NPC can't use would be dead weight, and this
  // stops a crafted request from persisting arbitrary slugs.
  const needed = new Set(neededSlugs(npc.permissions));
  const slugs = [...new Set(requested)].filter((s) => needed.has(s));

  await replaceVisitorGrants({
    townId: npc.townId,
    npcId: npc.id,
    visitorUserId,
    slugs,
  });

  return NextResponse.json({ ok: true, granted: slugs });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const resolved = await resolveNpcAndViewer(id);
  if (!resolved.ok) {
    return NextResponse.json(
      { error: errBody(resolved.status) },
      { status: resolved.status },
    );
  }
  if (!resolved.visitorUserId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await revokeAllVisitorGrants(resolved.npc.id, resolved.visitorUserId);
  return NextResponse.json({ ok: true, granted: [] });
}
