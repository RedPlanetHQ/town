// Persistent "which town is this user looking at?" cookie. Read on
// the root `/` route to choose the redirect target. The cookie is
// written by `apps/web/src/proxy.ts` on every /{slug} visit, since
// Next.js disallows cookie writes from Server Component render.
//
// Path `/`, SameSite=Lax, HttpOnly, Secure in production, 30-day TTL.

import { cookies } from "next/headers";

export const ACTIVE_SLUG_COOKIE = "town:active-slug";

export async function readActiveSlug(): Promise<string | null> {
  const jar = await cookies();
  const value = jar.get(ACTIVE_SLUG_COOKIE)?.value;
  return value && value.length > 0 ? value : null;
}
