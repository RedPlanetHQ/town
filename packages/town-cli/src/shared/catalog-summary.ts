// Project the full catalog + extras manifest down to the only fields a
// town-folder editor (human or agent) needs to know about:
//
//   • plots          — { plotKey, label, category, variants: [variantId, ...] }
//                      so you know what to put in `town.json#buildings`.
//   • exteriorSprites — every sprite path that appears in any catalog
//                      variant's `exteriorSpriteCandidates`. Used when
//                      remixing an existing exterior inside a customPlot.
//   • interiorSprites — every catalog interior shell.
//   • propSprites    — every catalog interior prop sprite path.
//   • decor          — the manifest, untouched (already slim).
//
// All the prose (vibe, profession, anchorObjects, triggers, paletteAccent)
// is dropped; the runtime doesn't read it from the local folder anyway —
// it lives in the server-side catalog. If a user wants to see the full
// canonical entry they can run `town init` against a live server and
// look at `catalog.json` over there.

interface RawNpcPosition {
  id?: string;
  tx: number;
  ty: number;
  label: string;
}

interface RawVariant {
  id: string;
  exteriorSpriteCandidates: string[];
  npcPosition?: RawNpcPosition;
  npcPositions?: RawNpcPosition[];
}

interface RawInterior {
  spriteCandidates: string[];
  props: Array<{ tx: number; ty: number; sprite: string }>;
}

interface RawPlot {
  id: string;
  label: string;
  category: string;
  interior: RawInterior;
  variants: RawVariant[];
}

interface RawCatalog {
  plots: RawPlot[];
}

export interface CatalogPlotSummary {
  plotKey: string;
  label: string;
  category: string;
  variants: Array<{
    id: string;
    exteriorSpriteCandidates: string[];
    /** Every NPC slot the variant supports. The CLI binds each
     *  npcs/<buildingId>__<slotId>.mdx to the matching entry's id. */
    npcSlots: Array<{ id: string; tx: number; ty: number; label: string }>;
  }>;
  /** Shape (spriteCandidates + props) for the shared interior. Mirrors
   *  the catalog so customPlots can copy an existing interior and tweak
   *  one prop without re-deriving positions. */
  interior: RawInterior;
}

export interface CatalogSummary {
  plots: CatalogPlotSummary[];
  exteriorSprites: string[];
  interiorSprites: string[];
  propSprites: string[];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

export function summarizeCatalog(raw: unknown): CatalogSummary {
  const cat = raw as RawCatalog;
  const plots: CatalogPlotSummary[] = (cat.plots ?? []).map((p) => ({
    plotKey: p.id,
    label: p.label,
    category: p.category,
    variants: (p.variants ?? []).map((v) => {
      const slotSource: RawNpcPosition[] =
        v.npcPositions && v.npcPositions.length > 0
          ? v.npcPositions
          : v.npcPosition
            ? [v.npcPosition]
            : [];
      return {
        id: v.id,
        exteriorSpriteCandidates: v.exteriorSpriteCandidates ?? [],
        npcSlots: slotSource.map((pos) => ({
          id: pos.id ?? "",
          tx: pos.tx,
          ty: pos.ty,
          label: pos.label,
        })),
      };
    }),
    interior: p.interior,
  }));

  const exteriorSprites = uniqueSorted(
    plots.flatMap((p) => p.variants.flatMap((v) => v.exteriorSpriteCandidates)),
  );
  const interiorSprites = uniqueSorted(
    plots.flatMap((p) => p.interior?.spriteCandidates ?? []),
  );
  const propSprites = uniqueSorted(
    plots.flatMap((p) => (p.interior?.props ?? []).map((prop) => prop.sprite)),
  );

  return { plots, exteriorSprites, interiorSprites, propSprites };
}
