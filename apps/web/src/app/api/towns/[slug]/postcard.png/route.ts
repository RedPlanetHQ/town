// GET /api/towns/[slug]/postcard.png
//
// Public, unauthenticated PNG render of the town. This is the URL that
// /[town] hands to og:image + twitter:image so link previews on X,
// LinkedIn, WhatsApp etc. show the postcard.
//
// No auth on purpose — Twitter / LinkedIn / WhatsApp crawlers can't
// present a session cookie or PAT, and the postcard is intentionally a
// public artifact tied to a publicly-shareable URL. The town's content
// is already what shows when a holder of the share code enters via
// /[town]; the postcard isn't extra information.
//
// Caching: 5 minutes browser/CDN. Plots don't change often and the
// rendering is non-trivial (decoding sprite PNGs + canvas compositing
// is ~hundreds of ms). The CDN absorbs the heat.

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { loadManifest } from "@/lib/manifest";
import { getPlotForTown } from "@/lib/plot";
import { getTownBySlug } from "@/lib/town";
import { renderTownPostcard } from "@/lib/town-export";

type Params = { slug: string };

export async function GET(_req: Request, ctx: { params: Promise<Params> }) {
  const { slug } = await ctx.params;
  const town = await getTownBySlug(slug);
  if (!town) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  const { plot } = await getPlotForTown(town.id);
  const [owner, npcCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: town.ownerId },
      select: { name: true },
    }),
    prisma.npc.count({ where: { townId: town.id } }),
  ]);

  let png: Buffer;
  try {
    png = await renderTownPostcard({
      plot,
      manifest: loadManifest(),
      townName: town.name,
      ownerName: owner?.name ?? "",
      // Static-snapshot population: owner + every authored NPC.
      population: npcCount + 1,
    });
  } catch (err) {
    console.error("[postcard.png] render failed", err);
    return NextResponse.json({ error: "render-failed" }, { status: 500 });
  }

  return new NextResponse(new Uint8Array(png), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control":
        "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
