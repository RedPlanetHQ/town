// Persistent "which town is this user looking at?" cookie. Read on
// the root `/` route to choose the redirect target; written on every
// /{slug} render where the user owns the town.
//
// Path `/`, SameSite=Lax, HttpOnly, Secure in production, 30-day TTL.

import { cookies } from "next/headers";

export const ACTIVE_SLUG_COOKIE = "town:active-slug";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

export async function readActiveSlug(): Promise<string | null> {
  const jar = await cookies();
  const value = jar.get(ACTIVE_SLUG_COOKIE)?.value;
  return value && value.length > 0 ? value : null;
}

export async function writeActiveSlug(slug: string): Promise<void> {
  const jar = await cookies();
  jar.set(ACTIVE_SLUG_COOKIE, slug, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: THIRTY_DAYS,
  });
}
