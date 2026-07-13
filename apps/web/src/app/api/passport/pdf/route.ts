import type { NextRequest } from "next/server";

import { getSessionFromCookie } from "@/lib/session";
import { loadGuestPassportData, loadPassportData } from "@/lib/passport/load";
import { renderPassportPdf } from "@/lib/passport/pdf";

export const runtime = "nodejs";

/**
 * GET /api/passport/pdf
 * Streams the caller's passport as a downloadable PDF, one spread per
 * page. Uses real data for signed-in users, or the guest's per-town
 * visitor cookies to build a provisional passport otherwise.
 */
export async function GET(_req: NextRequest) {
  const session = await getSessionFromCookie();
  const data = session
    ? await loadPassportData(session.userId)
    : await loadGuestPassportData();

  if (!data) return new Response("not found", { status: 404 });

  const pdf = await renderPassportPdf(data);
  const safeSlug = data.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "passport";
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${safeSlug}-passport.pdf"`,
      "cache-control": "no-store",
    },
  });
}
