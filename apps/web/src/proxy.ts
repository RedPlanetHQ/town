// Persist the most recently visited town slug as a cookie so the root
// `/` route can redirect signed-in owners back to where they were.
//
// Next.js disallows cookie writes from Server Component render, so this
// work moves to the proxy (formerly middleware). It fires on every
// request matching the matcher below; we only set the cookie when the
// URL is a single-segment path (a town slug). `getActiveTownForUser`
// re-validates ownership at read time, so writing for non-owners is
// harmless.
//
// Excluded by matcher: _next assets, api, items, static files with a
// dot in the basename.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { ACTIVE_SLUG_COOKIE } from "@/lib/active-slug";

const THIRTY_DAYS = 60 * 60 * 24 * 30;

export function proxy(req: NextRequest) {
  const segs = req.nextUrl.pathname.split("/").filter(Boolean);
  // Only single-segment paths can be town slugs.
  if (segs.length !== 1) return NextResponse.next();
  const slug = segs[0]!;
  // Belt-and-braces against routes the matcher doesn't exclude.
  if (slug.includes(".")) return NextResponse.next();

  const res = NextResponse.next();
  res.cookies.set(ACTIVE_SLUG_COOKIE, slug, {
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: THIRTY_DAYS,
    httpOnly: true,
  });
  return res;
}

export const config = {
  matcher: ["/((?!_next|api|items|favicon.ico|robots.txt).*)"],
};
