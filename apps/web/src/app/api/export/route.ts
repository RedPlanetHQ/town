// GET /api/export?town_name=<slug>
// Headers: Authorization: Bearer <CORE PAT>
//
// Returns a PNG of the requested town rendered server-side via
// renderTownPostcard. Same fit-width zoom + bottom trim + town-sign
// overlay the in-browser Share modal produces, so this endpoint is the
// canonical way to verify what the share image looks like without
// going through the modal.
//
// Auth: cookie session OR Bearer PAT (delegated to resolveUser). Today
// the endpoint only exposes the PAT holder's OWN town — looking up an
// arbitrary town would skip the visitor-cookie / share-code check.

import { NextResponse } from "next/server";

import { resolveUser } from "@/lib/auth-bearer";
import { prisma } from "@/lib/db";
import { loadManifest } from "@/lib/manifest";
import { getPlotForTown } from "@/lib/plot";
import { getTownsByOwner } from "@/lib/town";
import { normalizeSlug } from "@/lib/town-code";
import { renderTownPostcard } from "@/lib/town-export";

export async function GET(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rawTownName = url.searchParams.get("town_name")?.trim() ?? "";

  // Resolve the town. Default to the caller's most-recently-updated
  // town when no town_name is given. When a town_name is provided,
  // match against any of the caller's owned towns (PAT export skips
  // the share-code path intentionally).
  const owned = await getTownsByOwner(resolved.user.id);
  if (owned.length === 0) {
    return NextResponse.json({ error: "no-town" }, { status: 404 });
  }
  let ownTown = owned[0]!;
  if (rawTownName) {
    const candidateSlug = normalizeSlug(rawTownName);
    const match = owned.find(
      (t) =>
        t.slug === candidateSlug ||
        t.name.toLowerCase() === rawTownName.toLowerCase(),
    );
    if (!match) {
      return NextResponse.json(
        { error: "forbidden", detail: "PAT only exports the caller's own town" },
        { status: 403 },
      );
    }
    ownTown = match;
  }

  const { plot } = await getPlotForTown(ownTown.id);
  const [owner, npcCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: ownTown.ownerId },
      select: { name: true },
    }),
    prisma.npc.count({ where: { townId: ownTown.id } }),
  ]);

  let png: Buffer;
  try {
    png = await renderTownPostcard({
      plot,
      manifest: loadManifest(),
      townName: ownTown.name,
      ownerName: owner?.name ?? "",
      // Static-snapshot population: owner + every authored NPC.
      population: npcCount + 1,
    });
  } catch (err) {
    console.error("[export] render failed", err);
    return NextResponse.json({ error: "render-failed" }, { status: 500 });
  }

  return new NextResponse(new Uint8Array(png), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${ownTown.slug}.png"`,
    },
  });
}
