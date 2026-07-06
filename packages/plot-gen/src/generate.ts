// Top-level plot generator. Takes (seed, catalog, manifest, activeCount)
// and returns a fully-formed Plot ready to be persisted or rendered.

import type { Catalog, Plot as CatalogPlot, Variant } from "@town/catalog";
import { getSpriteDims } from "@town/catalog";
import type { CustomPlot, Manifest, Plot, PlotBuilding, PlotPath } from "@town/plot";
import { generateLayout, type BuildingRect } from "./layout";
import { roadTiles } from "./roads";
import { scatterDecor } from "./decor";
import { placePonds } from "./ponds";
import { PLOT_PRIORITY, WORLD, baseKey } from "./world";
import type { ClearingShape } from "./clearings";

export interface GenerateInput {
  seed: string;
  catalog: Catalog;
  manifest: Manifest;
  /** How many plots from PLOT_PRIORITY are active. Default 3 = day-0 trio. */
  activeCount?: number;
  /** Optional per-plotKey variant override. If absent, the first variant
   *  of each catalog plot is picked. */
  variantOverrides?: Record<string, string>;
  /** Plot id label. Default `${seed}-default`. */
  id?: string;
  /** User-defined plots. Carried straight through to the output Plot so
   *  the renderer + later incremental ops can see them. The base layout
   *  is still driven by PLOT_PRIORITY; only future `addBuilding` calls
   *  consult these. */
  customPlots?: CustomPlot[];
}

/** First `activeCount` plot keys from PLOT_PRIORITY. Mirrors the slice the
 *  layout walks; hoisted here so `generatePlot` can pre-resolve sprite
 *  dims for each active plot before running the layout. */
function activePlotKeys(activeCount: number): string[] {
  return PLOT_PRIORITY.slice(0, activeCount);
}

/** Resolve `plotKey` → catalog Plot + chosen Variant. Returns null if the
 *  plotKey isn't present in the catalog (e.g. a future tier 2 instance the
 *  catalog hasn't shipped yet). */
function resolveVariant(
  catalog: Catalog,
  plotKey: string,
  override?: string,
): { catalogPlot: CatalogPlot; variant: Variant } | null {
  const cp = catalog.plots.find((p) => p.id === baseKey(plotKey));
  if (!cp) return null;
  const variant = override
    ? cp.variants.find((v) => v.id === override) ?? cp.variants[0]
    : cp.variants[0];
  if (!variant) return null;
  return { catalogPlot: cp, variant };
}

export function generatePlot(input: GenerateInput): Plot {
  const seed = input.seed;
  const activeCount = input.activeCount ?? 3;
  const id = input.id ?? `${seed || "default"}-plot`;

  // 1. Pre-resolve each active plotKey → variant → sprite tile dims so the
  //    layout algorithm knows the actual footprint of every building it
  //    needs to place. Catalog variants pull dims from the baked
  //    sprite-dims map; buildings not in the catalog fall back to the
  //    extras manifest (workshop / stage / etc. that render from
  //    /sprites/extras/buildings). This is the fix for tall-sprite
  //    collisions — without dims the layout treated every building as
  //    10×7 and packed them close enough to overlap.
  const manifestBuildingById = new Map<string, { tileW: number; tileH: number }>();
  for (const mb of input.manifest.buildings ?? []) {
    manifestBuildingById.set(mb.id, { tileW: mb.tileW, tileH: mb.tileH });
  }
  function dimsFor(
    plotKey: string,
    exteriorSprite: string,
  ): { tileW: number; tileH: number } | undefined {
    const fromCatalog = getSpriteDims(exteriorSprite);
    if (fromCatalog) return fromCatalog;
    return manifestBuildingById.get(baseKey(plotKey));
  }

  // 2. Layout — cells → tile rects. Feeds in per-plotKey sprite dims so
  //    collision checks account for tall / wide sprites.
  const layoutDims: Record<string, { tileW: number; tileH: number }> = {};
  for (const plotKey of activePlotKeys(activeCount)) {
    const resolved = resolveVariant(input.catalog, plotKey, input.variantOverrides?.[plotKey]);
    if (!resolved) continue;
    const dims = dimsFor(plotKey, resolved.variant.exteriorSprite ?? "");
    if (dims) layoutDims[plotKey] = dims;
  }
  const layout = generateLayout(seed, activeCount, layoutDims);

  // 3. Flatten each placed cell into a PlotBuilding + ClearingShape.
  const buildings: PlotBuilding[] = [];
  const clearingShapes: ClearingShape[] = [];
  for (const plotKey of Object.keys(layout)) {
    const rect: BuildingRect = layout[plotKey]!;
    const resolved = resolveVariant(input.catalog, plotKey, input.variantOverrides?.[plotKey]);
    if (!resolved) continue;
    const { catalogPlot, variant } = resolved;
    const exteriorSprite = variant.exteriorSprite ?? "";
    const spriteDims = dimsFor(plotKey, exteriorSprite);
    buildings.push({
      id: plotKey,
      plotKey,
      variantId: variant.id,
      category: catalogPlot.category,
      tx: rect.tx,
      ty: rect.ty,
      w: rect.w,
      h: rect.h,
      exteriorSprite,
      ...(spriteDims ? { spriteW: spriteDims.tileW, spriteH: spriteDims.tileH } : {}),
    });
    clearingShapes.push({
      tx: rect.tx,
      ty: rect.ty,
      w: rect.w,
      h: rect.h,
      plotKey,
      ...(spriteDims ? { spriteW: spriteDims.tileW, spriteH: spriteDims.tileH } : {}),
    });
  }

  // 3. Roads — HOME → every other building.
  const home = buildings.find((b) => baseKey(b.plotKey) === "home");
  const paths: PlotPath[] = [];
  const pathTileSet = new Set<string>();
  if (home) {
    const homeShape = clearingShapes.find((s) => s.plotKey === home.plotKey)!;
    for (const b of buildings) {
      if (b.id === home.id) continue;
      const shape = clearingShapes.find((s) => s.plotKey === b.plotKey);
      if (!shape) continue;
      const tiles = roadTiles(seed, homeShape, shape, clearingShapes);
      paths.push({ from: home.id, to: b.id, tiles });
      for (const [x, y] of tiles) pathTileSet.add(x + "," + y);
    }
  }

  // 4. Ponds + decor.
  const { ponds, pondTiles } = placePonds(seed, clearingShapes, pathTileSet);
  const decor = scatterDecor({
    seed,
    manifest: input.manifest,
    buildings: clearingShapes,
    pathTiles: pathTileSet,
    pondTiles,
  });

  // 5. NPCs — one entry per slot the variant declares. Variants that
  //    only ship a singular `npcPosition` resolve to a single slot ""
  //    (the implicit default). Positions are INSIDE the interior — the
  //    overworld renderer ignores them, the interior scene reads them.
  const npcs = buildings.flatMap((b) => {
    const variant = input.catalog.plots
      .find((p) => p.id === baseKey(b.plotKey))
      ?.variants.find((v: Variant) => v.id === b.variantId);
    const slots = variant?.npcPositions ?? (variant?.npcPosition ? [variant.npcPosition] : []);
    if (slots.length === 0) {
      return [
        {
          buildingId: b.id,
          slotId: "",
          tx: 0,
          ty: 0,
          label: "occupant",
        },
      ];
    }
    return slots.map((slot) => ({
      buildingId: b.id,
      slotId: slot.id ?? "",
      tx: slot.tx,
      ty: slot.ty,
      label: slot.label,
    }));
  });

  return {
    schemaVersion: 1,
    id,
    seed,
    world: { w: WORLD.W, h: WORLD.H, tileSize: WORLD.TILE },
    buildings,
    paths,
    ponds,
    decor,
    npcs,
    ...(input.customPlots && input.customPlots.length > 0
      ? { customPlots: input.customPlots }
      : {}),
  };
}
