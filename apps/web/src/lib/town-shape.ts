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
import { getPlotForTown, savePlotForTown } from "./plot";

export interface TownShapeBuilding {
  id: string;
  plotKey: string;
  /** Optional — server picks the first variant for the plot when absent. */
  variantId?: string;
  /** Optional sign text. Renderer falls back to `id.toUpperCase()`. */
  label?: string;
  /** Per-house group-chat opt-in. See PlotBuilding.groupChatEnabled —
   *  CLI ↔ server round-trip this so `town deploy` can flip it. */
  groupChatEnabled?: boolean;
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
      ...(b.label ? { label: b.label } : {}),
      ...(b.groupChatEnabled ? { groupChatEnabled: true } : {}),
    })),
    customPlots: plot.customPlots ?? [],
  };
}

export interface TownNpcDTO {
  id: string;
  buildingId: string;
  slotId: string;
  name: string;
  description: string;
  prompt: string;
  /** Tool capability grant. Absent when the NPC has no tools.
   *  Shape mirrors NpcPermissions in lib/npc-templates.ts — we
   *  project the JSONB blob raw so `town clone` round-trips
   *  whatever the owner authored. */
  permissions?: unknown;
}

export async function loadTownNpcs(townId: string): Promise<TownNpcDTO[]> {
  const rows = await prisma.npc.findMany({
    where: { townId },
    orderBy: [{ buildingId: "asc" }, { slotId: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    buildingId: r.buildingId,
    slotId: r.slotId,
    name: r.name,
    description: r.description,
    prompt: r.prompt,
    ...(r.permissions != null ? { permissions: r.permissions } : {}),
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

/** Take the town's current Plot and apply a new town shape. Three modes:
 *
 *   1. No existing plot → generate a fresh Plot via `generatePlot` from
 *      the supplied buildings + customPlots, seeded by townId.
 *   2. Existing plot → diff buildings, run incremental ops (remove /
 *      change variant / add), then merge customPlots from the input.
 *
 *  The caller has already validated input shape; we still surface
 *  IncrementalError (no free cell, unknown plotKey, etc.) as a typed
 *  result so the route handler can return a structured 400. */
export async function applyTownShape(
  townId: string,
  input: ApplyTownShapeInput,
): Promise<ApplyTownShapeResult> {
  const manifest = loadManifest();
  const ctx: IncrementalCtx = { catalog, manifest };
  const customPlots = input.customPlots ?? [];

  const existing = await prisma.plotRow.findUnique({ where: { townId } });
  if (!existing) {
    // First-deploy path: build the plot from scratch. We seed the layout
    // with the FIRST-N buildings driven by PLOT_PRIORITY (the same way
    // `bootstrapPlot` does), then run incremental adds for any building
    // that wasn't included in the seeded layout.
    const seedPlot = generatePlot({
      seed: townId,
      catalog,
      manifest,
      activeCount: 0,
      id: `plot-${townId}`,
      customPlots,
    });
    return applyDiff(townId, seedPlot, input.buildings, ctx);
  }

  let next = existing.json as unknown as Plot;
  if (customPlots.length > 0 || next.customPlots) {
    next = { ...next, customPlots };
  }
  return applyDiff(townId, next, input.buildings, ctx);
}

async function applyDiff(
  townId: string,
  startingPlot: Plot,
  incoming: TownShapeBuilding[],
  ctx: IncrementalCtx,
): Promise<ApplyTownShapeResult> {
  const specs: BuildingSpec[] = incoming.map((b) => ({
    id: b.id,
    plotKey: b.plotKey,
    ...(b.variantId ? { variantId: b.variantId } : {}),
    ...(b.label !== undefined ? { label: b.label } : {}),
    ...(b.groupChatEnabled !== undefined
      ? { groupChatEnabled: b.groupChatEnabled }
      : {}),
  }));
  const diff = diffBuildings(startingPlot, specs, ctx);
  let nextPlot: Plot;
  try {
    nextPlot = applyBuildingDiff(startingPlot, ctx, diff);
  } catch (e) {
    if (e instanceof IncrementalError) throw e;
    throw e;
  }
  const { version } = await savePlotForTown(townId, nextPlot);
  return { plot: nextPlot, version };
}

/** Convenience for the GET handler — returns the projected shape. Will
 *  bootstrap a fresh plot if the town has none, matching legacy /api/plot
 *  semantics so `town clone` works even for fresh accounts. */
export async function getTownShape(townId: string): Promise<{
  shape: TownShape;
  version: number;
  npcs: TownNpcDTO[];
}> {
  const { plot, version } = await getPlotForTown(townId);
  const shape = projectTownShape(plot);
  const npcs = await loadTownNpcs(townId);
  return { shape, version, npcs };
}
