// Auth resolver that accepts either a town session cookie OR a CORE
// Personal Access Token via `Authorization: Bearer <pat>`. The PAT path
// is what the `town` CLI uses — it stores a CORE PAT in ~/.town/config.json
// and presents it on every request.
//
// PAT flow:
//   1. Pull the bearer token from the request header.
//   2. Call CORE `${CORE_OAUTH_BASE}/api/v1/me` with it.
//   3. If 200, upsert the town `User` keyed by `coreUserId = me.id` and
//      return the row. CLI requests don't need a town Session row — the
//      PAT itself is the credential.
//
// The cookie path is unchanged (Server Components / browser hits).

import { prisma } from "./db";
import { getSessionFromCookie } from "./session";

export interface ResolvedUser {
  user: {
    id: string;
    coreUserId: string;
    email: string;
    name: string;
    workspaceId: string | null;
  };
}

interface CoreMeResponse {
  id: string;
  name?: string | null;
  email?: string | null;
  workspaceId?: string | null;
}

async function fetchCoreMe(pat: string): Promise<CoreMeResponse | null> {
  const base = process.env.CORE_OAUTH_BASE;
  if (!base) {
    console.error("[auth-bearer] CORE_OAUTH_BASE not set");
    return null;
  }
  try {
    const res = await fetch(`${base}/api/v1/me`, {
      headers: { authorization: `Bearer ${pat}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as CoreMeResponse;
  } catch (e) {
    console.error("[auth-bearer] CORE /api/v1/me failed", e);
    return null;
  }
}

function readBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : null;
}

export async function resolveUser(req: Request): Promise<ResolvedUser | null> {
  // 1. Cookie session — what the browser uses.
  const session = await getSessionFromCookie();
  if (session) {
    return {
      user: {
        id: session.user.id,
        coreUserId: session.user.coreUserId,
        email: session.user.email,
        name: session.user.name,
        workspaceId: session.user.workspaceId ?? null,
      },
    };
  }

  // 2. Bearer PAT — what the CLI uses.
  const pat = readBearer(req);
  if (!pat) return null;

  const me = await fetchCoreMe(pat);
  if (!me) return null;

  // workspaceId is required. CORE /api/v1/me returns it for both OAuth
  // and PAT-issued tokens; if it's missing the caller's CORE account
  // has no workspace and we refuse to create a town-next row.
  const workspaceId = me.workspaceId ?? null;
  if (!workspaceId) {
    console.error("[auth-bearer] PAT login missing workspaceId for", me.id);
    return null;
  }
  const email = me.email ?? "";
  const name = me.name ?? "";

  // One-shot grace: adopt a pre-migration row with workspaceId=null
  // into this workspace instead of inserting a duplicate. Goes
  // dormant once every row has its workspaceId filled.
  let row;
  const legacy = await prisma.user.findFirst({
    where: { coreUserId: me.id, workspaceId: null },
  });
  if (legacy) {
    row = await prisma.user.update({
      where: { id: legacy.id },
      data: { workspaceId, email, name },
    });
  } else {
    row = await prisma.user.upsert({
      where: {
        coreUserId_workspaceId: { coreUserId: me.id, workspaceId },
      },
      create: { coreUserId: me.id, workspaceId, email, name },
      update: { email, name },
    });
  }

  return {
    user: {
      id: row.id,
      coreUserId: row.coreUserId,
      email: row.email,
      name: row.name,
      workspaceId: row.workspaceId,
    },
  };
}
