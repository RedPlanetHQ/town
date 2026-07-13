import type { NextRequest } from "next/server";

import { getSessionFromCookie } from "@/lib/session";
import { loadGuestPassportData, loadPassportData } from "@/lib/passport/load";
import { renderPreview } from "@/lib/passport/render";

export const runtime = "nodejs";

/**
 * GET /api/passport/preview
 * Returns the caller's passport as an SVG. Uses the signed-in user's
 * real data when authenticated, or the visitor's per-town cookies to
 * build a provisional guest passport otherwise.
 */
export async function GET(_req: NextRequest) {
  const session = await getSessionFromCookie();
  const data = session
    ? await loadPassportData(session.userId)
    : await loadGuestPassportData();

  if (!data) return new Response("not found", { status: 404 });

  return new Response(renderPreview(data), {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
