// GET /passport/[passportId]/pdf — public PDF download of any passport
// looked up by its public id. Mirrors /api/passport/pdf but keyed by
// url segment instead of session cookie.

import { loadPassportDataByPassportId } from "@/lib/passport/load";
import { renderPassportPdf } from "@/lib/passport/pdf";

export const runtime = "nodejs";

type Params = { passportId: string };

export async function GET(_req: Request, ctx: { params: Promise<Params> }) {
  const { passportId } = await ctx.params;
  const data = await loadPassportDataByPassportId(passportId);
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
