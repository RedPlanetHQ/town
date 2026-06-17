// Top-level plot generator. Takes (seed, catalog, manifest, activeCount)
// and returns a fully-formed Plot ready to be persisted or rendered.

import type { Catalog, Plot as CatalogPlot, Variant } from "@town/catalog";
import type { CustomPlot, Manifest, Plot, PlotBuilding, PlotPath } from "@town/plot";
import { generateLayout, type BuildingRect } from "./layout";
import { roadTiles } from "./roads";
import { scatterDecor } from "./decor";
import { placePonds } from "./ponds";
import { WORLD, baseKey } from "./world";
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

  // 1. Layout — cells → tile rects.
  const layout = generateLayout(seed, activeCount);

  // 2. Resolve catalog entries + flatten to PlotBuilding[]. Look up the
  //    actual sprite tile dimensions from the manifest so tall extras
  //    (stage / station / etc.) carve a tall clearing instead of a short
  //    round one — matches what the playground does in pgRenderMap.
  const manifestBuildingById = new Map<string, { tileW: number; tileH: number }>();
  for (const mb of input.manifest.buildings ?? []) {
    manifestBuildingById.set(mb.id, { tileW: mb.tileW, tileH: mb.tileH });
  }
  const buildings: PlotBuilding[] = [];
  const clearingShapes: ClearingShape[] = [];
  for (const plotKey of Object.keys(layout)) {
    const rect: BuildingRect = layout[plotKey]!;
    const resolved = resolveVariant(input.catalog, plotKey, input.variantOverrides?.[plotKey]);
    if (!resolved) continue;
    const { catalogPlot, variant } = resolved;
    const exteriorSprite = variant.exteriorSpriteCandidates[0] ?? "";
    const spriteDims = manifestBuildingById.get(baseKey(plotKey));
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

  // 5. NPCs — one per building, from the catalog variant's npcPosition.
  //    Position is INSIDE the interior; the overworld renderer ignores
  //    these (only used when entering the building scene).
  const npcs = buildings.map((b) => {
    const variant = input.catalog.plots
      .find((p) => p.id === baseKey(b.plotKey))
      ?.variants.find((v) => v.id === b.variantId);
    return {
      buildingId: b.id,
      tx: variant?.npcPosition.tx ?? 0,
      ty: variant?.npcPosition.ty ?? 0,
      label: variant?.npcPosition.label ?? "occupant",
    };
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
