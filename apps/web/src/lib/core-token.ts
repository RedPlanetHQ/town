// Resolve a usable CORE access token from a Route Handler request,
// whichever auth mode the caller used:
//
//   • Cookie session — grab the user's stored OAuth access_token (refreshed
//     transparently if it's about to expire).
//   • Bearer PAT — the CLI passes its CORE PAT as `Authorization: Bearer`;
//     we just hand the same token back.
//
// The returned token can be used directly against CORE's /api/v1/* surface
// — same auth header CORE accepts everywhere.

import { cookies } from "next/headers";
import { prisma } from "./db";
import { SESSION_COOKIE, getAccessTokenForSession } from "./session";

function readBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : null;
}

export async function getCoreToken(req: Request): Promise<string | null> {
  const bearer = readBearer(req);
  if (bearer) return bearer;
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  try {
    return await getAccessTokenForSession(sid);
  } catch {
    return null;
  }
}

// Resolve a CORE access token for a specific town User (the *owner*),
// regardless of who's actually calling the route. This is what every
// NPC chat uses for `memory_search`: the NPC searches the town owner's
// CORE memory, and the owner's authored NPC prompt is what decides
// how much of it leaks to visitors. Picks the most-recently-used
// non-expired Session row for the user and refreshes its access token
// if needed. Returns null if the owner has no usable session (e.g.
// only ever signed in via PAT) — callers should handle that by
// returning a "no memory available" tool result rather than 5xx.
export async function getOwnerCoreToken(
  ownerUserId: string,
): Promise<string | null> {
  const session = await prisma.session.findFirst({
    where: {
      userId: ownerUserId,
      expiresAt: { gt: new Date() },
    },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true },
  });
  if (!session) return null;
  try {
    return await getAccessTokenForSession(session.id);
  } catch {
    return null;
  }
}
