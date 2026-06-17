// Server-side helpers for the `/api/town` shape — the high-level view of
// a town the CLI sees. Internally the server still owns the full Plot;
// these helpers project it down for reads and apply incoming diffs +
// fresh generations for writes.

import { catalog } from "@town/catalog";
import { generatePlot } from "@town/plot-gen";
import {
  applyBuildingDiff,
  diffBuildings,
  IncrementalError,
  type BuildingSpec,
  type IncrementalCtx,
} from "@town/plot-gen";
import type { CustomPlot, Plot } from "@town/plot";

import { prisma } from "./db";
import { loadManifest } from "./manifest";
import { getPlotForUser, savePlotForUser } from "./plot";

export interface TownShapeBuilding {
  id: string;
  plotKey: string;
  /** Optional — server picks the first variant for the plot when absent. */
  variantId?: string;
}

export interface TownShape {
  buildings: TownShapeBuilding[];
  customPlots: CustomPlot[];
}

/** Project a Plot down to the (buildings, customPlots) view the CLI
 *  edits. Tile coords, paths, ponds, and decor are intentionally
 *  hidden — the server owns layout. */
export function projectTownShape(plot: Plot): TownShape {
  return {
    buildings: plot.buildings.map((b) => ({
      id: b.id,
      plotKey: b.plotKey,
      variantId: b.variantId,
    })),
    customPlots: plot.customPlots ?? [],
  };
}

export interface TownNpcDTO {
  id: string;
  buildingId: string;
  name: string;
  description: string;
  prompt: string;
}

export async function loadTownNpcs(userId: string): Promise<TownNpcDTO[]> {
  const rows = await prisma.npc.findMany({
    where: { userId },
    orderBy: { buildingId: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    buildingId: r.buildingId,
    name: r.name,
    description: r.description,
    prompt: r.prompt,
  }));
}

export interface ApplyTownShapeInput {
  buildings: TownShapeBuilding[];
  customPlots?: CustomPlot[];
}

export interface ApplyTownShapeResult {
  plot: Plot;
  version: number;
}

/** Take the user's current Plot and apply a new town shape. Three modes:
 *
 *   1. No existing plot → generate a fresh Plot via `generatePlot` from
 *      the supplied buildings + customPlots, seeded by userId.
 *   2. Existing plot → diff buildings, run incremental ops (remove /
 *      change variant / add), then merge customPlots from the input.
 *
 *  The caller has already validated input shape; we still surface
 *  IncrementalError (no free cell, unknown plotKey, etc.) as a typed
 *  result so the route handler can return a structured 400. */
export async function applyTownShape(
  userId: string,
  input: ApplyTownShapeInput,
): Promise<ApplyTownShapeResult> {
  const manifest = loadManifest();
  const ctx: IncrementalCtx = { catalog, manifest };
  const customPlots = input.customPlots ?? [];

  const existing = await prisma.plotRow.findUnique({ where: { userId } });
  if (!existing) {
    // First-deploy path: build the plot from scratch. We seed the layout
    // with the FIRST-N buildings driven by PLOT_PRIORITY (the same way
    // `bootstrapPlot` does), then run incremental adds for any building
    // that wasn't included in the seeded layout.
    const seedPlot = generatePlot({
      seed: userId,
      catalog,
      manifest,
      activeCount: 0,
      id: `plot-${userId}`,
      customPlots,
    });
    return applyDiff(userId, seedPlot, input.buildings, ctx);
  }

  let next = existing.json as unknown as Plot;
  if (customPlots.length > 0 || next.customPlots) {
    next = { ...next, customPlots };
  }
  return applyDiff(userId, next, input.buildings, ctx);
}

async function applyDiff(
  userId: string,
  startingPlot: Plot,
  incoming: TownShapeBuilding[],
  ctx: IncrementalCtx,
): Promise<ApplyTownShapeResult> {
  const specs: BuildingSpec[] = incoming.map((b) => ({
    id: b.id,
    plotKey: b.plotKey,
    ...(b.variantId ? { variantId: b.variantId } : {}),
  }));
  const diff = diffBuildings(startingPlot, specs);
  let nextPlot: Plot;
  try {
    nextPlot = applyBuildingDiff(startingPlot, ctx, diff);
  } catch (e) {
    if (e instanceof IncrementalError) throw e;
    throw e;
  }
  const { version } = await savePlotForUser(userId, nextPlot);
  return { plot: nextPlot, version };
}

/** Convenience for the GET handler — returns the projected shape. Will
 *  bootstrap a fresh plot if the user has none, matching legacy /api/plot
 *  semantics so `town clone` works even for fresh accounts. */
export async function getTownShape(userId: string): Promise<{
  shape: TownShape;
  version: number;
  npcs: TownNpcDTO[];
}> {
  const { plot, version } = await getPlotForUser(userId);
  const shape = projectTownShape(plot);
  const npcs = await loadTownNpcs(userId);
  return { shape, version, npcs };
}
