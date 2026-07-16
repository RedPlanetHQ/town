// /api/npcs/[id]/permissions — owner-only management of an NPC's
// capability grants.
//
//   GET  /api/npcs/<id>/permissions
//        → { permissions, available }  stored grants + the owner's
//          connected CORE integrations (fetched with the owner's own
//          token — this route is owner-only, so caller IS owner).
//   GET  ...?actions_for=<integration_account_id>
//        → { actions }  lazy per-integration action list, split out so
//          opening the panel doesn't spawn N CORE tool lookups.
//   PUT  /api/npcs/<id>/permissions   { permissions }
//        → { ok, permissions }  runs through normalizePermissions(),
//          the same normaliser `town deploy` uses, so the UI and the
//          CLI can't diverge on shape.
//
// Auth: session cookie or CORE PAT (lib/auth-bearer), then an explicit
// npc→town→ownerId check. Visitors get 403.

import { NextResponse } from "next/server";

import { resolveUser } from "@/lib/auth-bearer";
import { getCoreToken } from "@/lib/core-token";
import { prisma } from "@/lib/db";
import { normalizePermissions } from "@/lib/npc-templates";

const CORE_BASE = () => process.env.CORE_OAUTH_BASE;

/** Load the NPC and verify the caller owns its town. Returns null on
 *  any miss — callers map that to 404/403 without leaking which. */
async function resolveOwnedNpc(req: Request, npcId: string) {
  const resolved = await resolveUser(req);
  if (!resolved) return { error: 401 as const };
  const npc = await prisma.npc.findUnique({
    where: { id: npcId },
    include: { town: { select: { id: true, slug: true, ownerId: true } } },
  });
  if (!npc) return { error: 404 as const };
  if (npc.town.ownerId !== resolved.user.id) return { error: 403 as const };
  return { npc, user: resolved.user };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const owned = await resolveOwnedNpc(req, id);
  if ("error" in owned) {
    return NextResponse.json(
      {
        error:
          owned.error === 401
            ? "unauthorized"
            : owned.error === 403
              ? "forbidden"
              : "not-found",
      },
      { status: owned.error },
    );
  }

  const base = CORE_BASE();
  const token = await getCoreToken(req);
  if (!base || !token) {
    // Owner has no live CORE session (e.g. PAT-only login that expired).
    // Still return the stored permissions so the panel renders read-only.
    return NextResponse.json({
      permissions: owned.npc.permissions ?? {},
      available: [],
      warning: "core-unavailable",
    });
  }

  const url = new URL(req.url);
  const actionsFor = url.searchParams.get("actions_for");

  // Lazy action-list branch — proxies CORE's
  // GET /api/v1/integration_account/:id/action (see core's
  // integration-operations.ts). We proxy rather than letting the browser
  // hit CORE directly because the browser never holds CORE tokens
  // (AGENTS.md: only the opaque sid cookie).
  if (actionsFor) {
    const res = await fetch(
      `${base}/api/v1/integration_account/${encodeURIComponent(actionsFor)}/action`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      console.warn(`[npc-permissions] CORE ${res.status} listing actions`);
      return NextResponse.json({ actions: [], warning: `core-${res.status}` });
    }
    const data = (await res.json()) as {
      actions?: Array<{ name?: string; description?: string }>;
    };
    return NextResponse.json({
      // Only name + description reach the browser — inputSchema is model
      // material, not something the whitelist UI needs.
      actions: (data.actions ?? [])
        .filter((a) => typeof a.name === "string")
        .map((a) => ({ name: a.name, description: a.description ?? "" })),
    });
  }

  // Main branch: stored grants + the owner's connected integrations.
  const res = await fetch(`${base}/api/v1/integration_account`, {
    headers: { authorization: `Bearer ${token}` },
  });
  let available: Array<{
    integration_account_id: string;
    slug: string;
    name: string;
  }> = [];
  if (res.ok) {
    const data = (await res.json()) as {
      accounts?: Array<{
        id?: string;
        integrationDefinition?: { slug?: string; name?: string };
      }>;
    };
    available = (data.accounts ?? [])
      .filter(
        (a) =>
          typeof a.id === "string" &&
          typeof a.integrationDefinition?.slug === "string",
      )
      .map((a) => ({
        integration_account_id: a.id!,
        slug: a.integrationDefinition!.slug!,
        name: a.integrationDefinition!.name ?? a.integrationDefinition!.slug!,
      }));
  } else {
    console.warn(`[npc-permissions] CORE ${res.status} listing accounts`);
  }

  return NextResponse.json({
    permissions: owned.npc.permissions ?? {},
    available,
  });
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const owned = await resolveOwnedNpc(req, id);
  if ("error" in owned) {
    return NextResponse.json(
      {
        error:
          owned.error === 401
            ? "unauthorized"
            : owned.error === 403
              ? "forbidden"
              : "not-found",
      },
      { status: owned.error },
    );
  }

  let body: { permissions?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }

  // normalizePermissions drops anything it doesn't recognise, so a
  // malformed/hostile payload degrades to a NARROWER grant, never a
  // wider one. Same failure posture as the MDX loader.
  const permissions = normalizePermissions(body.permissions);

  await prisma.npc.update({
    where: { id: owned.npc.id },
    data: { permissions: permissions as object },
  });

  console.log("[npc-permissions] updated", {
    npcId: owned.npc.id,
    townSlug: owned.npc.town.slug,
    integrations: permissions.integrations?.map((g) => ({
      slug: g.slug,
      actions: g.actions?.length ?? "all",
      owner_only: g.owner_only ?? false,
    })),
  });

  return NextResponse.json({ ok: true, permissions });
}
