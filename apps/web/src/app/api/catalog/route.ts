// /api/catalog
//
//   GET → { ...catalog, plotKeys: [...] }
//
// Public, cached. Two consumers:
//
//   1. The static catalog browser at /sprites/catalog/index.html — reads
//      `data.plots` (the raw `@town/catalog` payload).
//
//   2. The CLI and (future) chat-creator agent — read `data.plotKeys`,
//      a tool-friendly projection that surfaces the canonical key, its
//      category, the global PLOT_W × PLOT_H footprint, the available
//      variants, and the distinct NPC slot ids per plot. This is the
//      shape CLIs scaffold town.json against without bundling the
//      manifest.
//
// Both shapes ride one response so neither consumer needs a second
// round-trip and the static browser keeps working unchanged.

import { NextResponse } from "next/server";

import { catalog } from "@town/catalog";
import { WORLD, PLOT_PRIORITY, baseKey } from "@town/plot-gen";

export const runtime = "nodejs";
export const dynamic = "force-static";
export const revalidate = 300;

export async function GET() {
  // Every plot footprint is the same global PLOT_W × PLOT_H tile
  // budget — buildings/variants don't carry per-key dimensions in this
  // codebase. Expose the shared constants so tools can size sprites
  // without having to import @town/plot-gen.
  const widthTiles = WORLD.PLOT_W;
  const heightTiles = WORLD.PLOT_H;

  // Walk PLOT_PRIORITY so instance-suffix keys ("home-2", "office-3")
  // get their own entry — that's the surface the CLI shapes town.json
  // against.
  const plotKeys = PLOT_PRIORITY.map((key) => {
    const base = baseKey(key);
    const def = catalog.plots.find((p) => p.id === base);
    if (!def) {
      return {
        key,
        category: "unknown",
        widthTiles,
        heightTiles,
        variants: [],
        npcSlots: [],
      };
    }
    // Distinct NPC slot ids across all variants. Variants share the
    // interior, so two variants exposing the same `barista` slot
    // produce a single entry here.
    const npcSlots = def.variants
      .flatMap((v) => v.npcPositions ?? (v.npcPosition ? [v.npcPosition] : []))
      .reduce<Array<{ id: string; tx: number; ty: number }>>((acc, s) => {
        const id = s.id ?? "";
        if (!acc.some((a) => a.id === id)) {
          acc.push({ id, tx: s.tx, ty: s.ty });
        }
        return acc;
      }, []);
    return {
      key,
      category: def.category,
      widthTiles,
      heightTiles,
      variants: def.variants.map((v) => ({
        id: v.id,
        exteriorSprite: v.exteriorSprite,
      })),
      npcSlots,
    };
  });

  return NextResponse.json(
    { ...catalog, plotKeys },
    {
      headers: {
        "Cache-Control":
          "public, max-age=300, stale-while-revalidate=60",
      },
    },
  );
}
