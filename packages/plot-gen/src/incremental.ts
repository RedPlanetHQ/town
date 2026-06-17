// Incremental plot ops — add, remove, and re-variant a single building,
// then re-scatter decor over the resulting layout. Ponds are preserved
// as-is (regenerating them would shift water around the map every time
// the user touches a building, which would be a destructive surprise).
//
// All ops are pure: they take a `Plot` and return a new one. The caller
// (typically `/api/town`'s POST handler) is responsible for persisting
// the result.
//
// Design constraints:
//   • Decor stability — `scatterDecor` hashes per-tile by seed, so
//     untouched tiles produce identical sprite picks across calls. Tiles
//     newly inside or outside a clearing flip predictably.
//   • Slot search — `addBuilding` walks the world grid in row-major
//     order and stops at the first cell whose jittered rect doesn't
//     intersect any existing building. Deterministic given the seed,
//     so re-running the op yields the same placement.

import type { Catalog } from "@town/catalog";
import type {
  CustomPlot,
  Manifest,
  Plot,
  PlotBuilding,
  PlotPath,
} from "@town/plot";

import { type ClearingShape } from "./clearings";
import { scatterDecor } from "./decor";
import { hash32 } from "./rng";
import { roadTiles } from "./roads";
import { WORLD, baseKey } from "./world";
import {
  pickVariant,
  resolveEffectivePlot,
  type EffectivePlot,
  type EffectiveVariant,
} from "./effective-catalog";

export interface IncrementalCtx {
  catalog: Catalog;
  manifest: Manifest;
}

export class IncrementalError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "IncrementalError";
  }
}

// ---- Internal helpers --------------------------------------------------

function buildingToClearing(b: PlotBuilding): ClearingShape {
  return {
    tx: b.tx,
    ty: b.ty,
    w: b.w,
    h: b.h,
    plotKey: b.plotKey,
    ...(b.spriteW !== undefined ? { spriteW: b.spriteW } : {}),
    ...(b.spriteH !== undefined ? { spriteH: b.spriteH } : {}),
  };
}

function rectsOverlap(
  a: { tx: number; ty: number; w: number; h: number },
  b: { tx: number; ty: number; w: number; h: number },
  pad = 0,
): boolean {
  return (
    a.tx - pad < b.tx + b.w &&
    a.tx + a.w + pad > b.tx &&
    a.ty - pad < b.ty + b.h &&
    a.ty + a.h + pad > b.ty
  );
}

/** Walk the world grid for the first cell whose jittered rect doesn't
 *  collide with any existing building. Search order is salted by seed +
 *  plotKey so two different additions to the same plot don't fight over
 *  the same cell. */
function findFreeRect(
  plot: Plot,
  plotKey: string,
  manifestDims: { tileW: number; tileH: number } | undefined,
): { tx: number; ty: number; w: number; h: number } | null {
  const seed = plot.seed || "town";
  // Per-(seed, plotKey) cell order. Same input → same answer.
  const cells: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < WORLD.ROWS; r++) {
    for (let c = 0; c < WORLD.COLS; c++) cells.push({ col: c, row: r });
  }
  cells.sort((a, b) => {
    const ha = hash32(seed + "::add::" + plotKey + "::" + a.col + "," + a.row);
    const hb = hash32(seed + "::add::" + plotKey + "::" + b.col + "," + b.row);
    return ha - hb;
  });

  for (const cell of cells) {
    const baseTx = cell.col * WORLD.CELL_W + (WORLD.CELL_W - WORLD.PLOT_W) / 2;
    const baseTy = cell.row * WORLD.CELL_H + (WORLD.CELL_H - WORLD.PLOT_H) / 2;
    const h = hash32(seed + "::jit::" + plotKey + "::" + cell.col + "," + cell.row);
    const jx = ((h & 0xffff) / 65535 - 0.5) * 3;
    const jy = (((h >>> 16) & 0xffff) / 65535 - 0.5) * 3;
    const tx = Math.round(Math.max(4, Math.min(WORLD.W - WORLD.PLOT_W - 4, baseTx + jx)));
    const ty = Math.round(Math.max(4, Math.min(WORLD.H - WORLD.PLOT_H - 4, baseTy + jy)));
    const rect = { tx, ty, w: WORLD.PLOT_W, h: WORLD.PLOT_H };

    let collides = false;
    for (const b of plot.buildings) {
      if (rectsOverlap(rect, b, 1)) {
        collides = true;
        break;
      }
    }
    if (!collides) {
      // The footprint search uses the layout PLOT_W/H; surface the
      // manifest dims separately so the building entry can render a
      // taller sprite without changing the no-overlap footprint.
      void manifestDims;
      return rect;
    }
  }
  return null;
}

function manifestBuildingDims(
  manifest: Manifest,
  plotKey: string,
): { tileW: number; tileH: number } | undefined {
  const base = baseKey(plotKey);
  return (manifest.buildings ?? []).find((mb) => mb.id === base)
    ? (() => {
        const mb = (manifest.buildings ?? []).find((m) => m.id === base)!;
        return { tileW: mb.tileW, tileH: mb.tileH };
      })()
    : undefined;
}

function rescatterDecor(plot: Plot, manifest: Manifest): Plot["decor"] {
  const buildings = plot.buildings.map(buildingToClearing);
  const pathTiles = new Set<string>();
  for (const p of plot.paths) for (const [x, y] of p.tiles) pathTiles.add(x + "," + y);
  const pondTiles = new Set<string>();
  for (const pond of plot.ponds) {
    for (let dy = 0; dy < pond.h; dy++) {
      for (let dx = 0; dx < pond.w; dx++) {
        pondTiles.add(pond.tx + dx + "," + (pond.ty + dy));
      }
    }
  }
  return scatterDecor({
    seed: plot.seed,
    manifest,
    buildings,
    pathTiles,
    pondTiles,
  });
}

function ensureHome(plot: Plot): PlotBuilding {
  const home = plot.buildings.find((b) => baseKey(b.plotKey) === "home");
  if (!home) {
    throw new IncrementalError(
      "missing-home",
      "plot has no HOME building — every plot must keep its home",
    );
  }
  return home;
}

// ---- Public ops --------------------------------------------------------

export interface AddBuildingInput {
  /** plotKey to add — catalog id, instance suffix (e.g. "office-2"), or
   *  "custom:<id>" for a user-defined plot. */
  plotKey: string;
  /** Stable id for the new building. Defaults to plotKey. Must not
   *  collide with any existing PlotBuilding.id. */
  id?: string;
  /** Variant id; first variant if omitted. */
  variantId?: string;
}

export interface AddBuildingResult {
  plot: Plot;
  building: PlotBuilding;
}

/** Add one building, route a path from HOME, refresh decor. Pure. */
export function addBuilding(
  plot: Plot,
  ctx: IncrementalCtx,
  input: AddBuildingInput,
): AddBuildingResult {
  const customPlots = plot.customPlots ?? [];
  const eff = resolveEffectivePlot(ctx.catalog, customPlots, input.plotKey);
  if (!eff) {
    throw new IncrementalError(
      "unknown-plot-key",
      `plotKey "${input.plotKey}" is not in the catalog or in plot.customPlots`,
    );
  }
  const variant = pickVariant(eff, input.variantId);
  if (!variant) {
    throw new IncrementalError(
      "unknown-variant",
      `variantId "${input.variantId ?? "(first)"}" not found on plot "${input.plotKey}"`,
    );
  }

  const id = input.id ?? input.plotKey;
  if (plot.buildings.some((b) => b.id === id)) {
    throw new IncrementalError(
      "duplicate-building-id",
      `a building with id "${id}" already exists`,
    );
  }

  const dims = manifestBuildingDims(ctx.manifest, input.plotKey);
  const rect = findFreeRect(plot, input.plotKey, dims);
  if (!rect) {
    throw new IncrementalError(
      "no-free-cell",
      "no free cell available for a new building — remove one first",
    );
  }

  const exteriorSprite = variant.exteriorSpriteCandidates[0] ?? "";
  const building: PlotBuilding = {
    id,
    plotKey: input.plotKey,
    variantId: variant.id,
    category: eff.category,
    tx: rect.tx,
    ty: rect.ty,
    w: rect.w,
    h: rect.h,
    exteriorSprite,
    ...(dims ? { spriteW: dims.tileW, spriteH: dims.tileH } : {}),
  };

  const home = ensureHome(plot);
  const allClearings: ClearingShape[] = [
    ...plot.buildings.map(buildingToClearing),
    buildingToClearing(building),
  ];
  const homeShape = buildingToClearing(home);
  const newShape = buildingToClearing(building);
  let path: PlotPath | null = null;
  if (home.id !== building.id) {
    const tiles = roadTiles(plot.seed, homeShape, newShape, allClearings);
    path = { from: home.id, to: building.id, tiles };
  }

  const buildings = [...plot.buildings, building];
  const paths = path ? [...plot.paths, path] : plot.paths;
  const npcs = [
    ...plot.npcs,
    {
      buildingId: building.id,
      tx: variant.npcPosition.tx,
      ty: variant.npcPosition.ty,
      label: variant.npcPosition.label,
    },
  ];

  const next: Plot = { ...plot, buildings, paths, npcs };
  next.decor = rescatterDecor(next, ctx.manifest);
  return { plot: next, building };
}

export interface RemoveBuildingInput {
  id: string;
}

/** Remove one building, drop all paths touching it, refresh decor. */
export function removeBuilding(
  plot: Plot,
  ctx: IncrementalCtx,
  input: RemoveBuildingInput,
): Plot {
  const target = plot.buildings.find((b) => b.id === input.id);
  if (!target) {
    throw new IncrementalError(
      "unknown-building",
      `no building with id "${input.id}" in plot`,
    );
  }
  if (baseKey(target.plotKey) === "home") {
    throw new IncrementalError(
      "remove-home-forbidden",
      "cannot remove the HOME building",
    );
  }
  const buildings = plot.buildings.filter((b) => b.id !== input.id);
  const paths = plot.paths.filter((p) => p.from !== input.id && p.to !== input.id);
  const npcs = plot.npcs.filter((n) => n.buildingId !== input.id);
  const next: Plot = { ...plot, buildings, paths, npcs };
  next.decor = rescatterDecor(next, ctx.manifest);
  return next;
}

export interface ChangeVariantInput {
  id: string;
  variantId: string;
}

/** Swap a building's variant — sprite + npcPosition only. No layout
 *  movement, no decor recomputation. */
export function changeVariant(
  plot: Plot,
  ctx: IncrementalCtx,
  input: ChangeVariantInput,
): Plot {
  const idx = plot.buildings.findIndex((b) => b.id === input.id);
  if (idx === -1) {
    throw new IncrementalError(
      "unknown-building",
      `no building with id "${input.id}" in plot`,
    );
  }
  const current = plot.buildings[idx]!;
  const eff = resolveEffectivePlot(
    ctx.catalog,
    plot.customPlots ?? [],
    current.plotKey,
  );
  if (!eff) {
    throw new IncrementalError(
      "unknown-plot-key",
      `plotKey "${current.plotKey}" no longer resolves`,
    );
  }
  const variant = eff.variants.find((v: EffectiveVariant) => v.id === input.variantId);
  if (!variant) {
    throw new IncrementalError(
      "unknown-variant",
      `variantId "${input.variantId}" not on plot "${current.plotKey}"`,
    );
  }
  const exteriorSprite = variant.exteriorSpriteCandidates[0] ?? current.exteriorSprite;
  const buildings = plot.buildings.slice();
  buildings[idx] = { ...current, variantId: variant.id, exteriorSprite };
  const npcs = plot.npcs.map((n) =>
    n.buildingId === input.id
      ? {
          ...n,
          tx: variant.npcPosition.tx,
          ty: variant.npcPosition.ty,
          label: variant.npcPosition.label,
        }
      : n,
  );
  return { ...plot, buildings, npcs };
}

// Surfaced so the diff helper below can reuse the same `EffectivePlot`
// type without callers needing to import effective-catalog separately.
export type { EffectivePlot, EffectiveVariant };

// ---- Diff helper -------------------------------------------------------

/** A building list as supplied by the CLI — pruned PlotBuilding. */
export interface BuildingSpec {
  id: string;
  plotKey: string;
  variantId?: string;
}

export interface BuildingDiff {
  added: BuildingSpec[];
  removed: string[];
  changedVariant: Array<{ id: string; variantId: string }>;
  /** Any spec that names an existing id with a DIFFERENT plotKey. We
   *  treat these as remove-then-add. */
  rebuild: BuildingSpec[];
}

/** Diff a current plot against an incoming building list. The result
 *  feeds straight into a sequence of incremental ops. */
export function diffBuildings(plot: Plot, incoming: BuildingSpec[]): BuildingDiff {
  const current = new Map(plot.buildings.map((b) => [b.id, b]));
  const next = new Map(incoming.map((b) => [b.id, b]));

  const added: BuildingSpec[] = [];
  const removed: string[] = [];
  const changedVariant: Array<{ id: string; variantId: string }> = [];
  const rebuild: BuildingSpec[] = [];

  for (const [id, spec] of next.entries()) {
    const have = current.get(id);
    if (!have) {
      added.push(spec);
      continue;
    }
    if (have.plotKey !== spec.plotKey) {
      rebuild.push(spec);
      continue;
    }
    if (spec.variantId && spec.variantId !== have.variantId) {
      changedVariant.push({ id, variantId: spec.variantId });
    }
  }
  for (const id of current.keys()) {
    if (!next.has(id)) removed.push(id);
  }

  return { added, removed, changedVariant, rebuild };
}

/** Apply a BuildingDiff to a Plot, calling the right incremental op per
 *  entry. Order: removals + rebuild removals → variant changes →
 *  additions + rebuild additions. That keeps the slot search as
 *  unconstrained as possible. */
export function applyBuildingDiff(
  plot: Plot,
  ctx: IncrementalCtx,
  diff: BuildingDiff,
): Plot {
  let next = plot;
  for (const id of diff.removed) {
    next = removeBuilding(next, ctx, { id });
  }
  for (const spec of diff.rebuild) {
    next = removeBuilding(next, ctx, { id: spec.id });
  }
  for (const ch of diff.changedVariant) {
    next = changeVariant(next, ctx, ch);
  }
  for (const spec of diff.added) {
    next = addBuilding(next, ctx, spec).plot;
  }
  for (const spec of diff.rebuild) {
    next = addBuilding(next, ctx, spec).plot;
  }
  return next;
}
