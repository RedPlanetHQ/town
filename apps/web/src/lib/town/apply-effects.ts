// Apply ONE approved effect for a town. Runs when a PlotSuggestion is
// approved via /api/suggestions/[id]/approve.
//
// add-building: walk the catalog's PLOT_PRIORITY in order, find the first
// plotKey that matches the requested base (e.g. "studio" → "studio" or
// "studio-2" if "studio" is already taken) that isn't already in the
// town's plot, then regenerate the plot via the seed-based generator with
// activeCount = current count + 1. We don't surgically inject — letting
// the generator place the new building keeps clearings + roads + decor
// consistent with the rest of the town. seedNpcs() then materialises the
// default NPC for the new building (idempotent — only fills empties).
//
// update-npc: patch the Npc row's description and/or prompt.
//
// add-npc: insert a new Npc row attached to an existing buildingId.
//
// On any plot mutation we bump PlotRow.version so the kaplay scene's
// poller picks up the change.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { catalog } from "@town/catalog";
import { generatePlot, PLOT_PRIORITY, baseKey } from "@town/plot-gen";
import type { Manifest, Plot } from "@town/plot";

import { prisma } from "@/lib/db";
import { seedNpcs } from "@/lib/plot";
import type { Effect } from "./decide";

let cachedManifest: Manifest | null = null;
function getManifest(): Manifest {
  if (cachedManifest) return cachedManifest;
  const path = resolve(
    process.cwd(),
    "public",
    "sprites",
    "extras",
    "MANIFEST.json",
  );
  cachedManifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  return cachedManifest;
}

export interface ApplyResult {
  applied: boolean;
  reason?: string;
}

/** Apply a single approved effect. Returns whether the effect actually
 *  resulted in a write (some effects no-op if the world already moved on,
 *  e.g. the building already exists). */
export async function applyEffect(
  townId: string,
  effect: Effect,
): Promise<ApplyResult> {
  if (effect.kind === "add-building") {
    const row = await prisma.plotRow.findUnique({ where: { townId } });
    if (!row) return { applied: false, reason: "town has no plot row" };
    const plot = row.json as unknown as Plot;
    const resolvedKey = pickInstanceKey(effect.plotKey, plot);
    if (!resolvedKey) {
      return { applied: false, reason: "no catalog room for another instance" };
    }
    const target = plot.buildings.length + 1;
    const regenerated = generatePlot({
      seed: plot.seed,
      catalog,
      manifest: getManifest(),
      activeCount: nextActiveCount(plot, resolvedKey, target),
      id: plot.id,
    });
    await prisma.plotRow.update({
      where: { townId },
      data: {
        json: regenerated as unknown as object,
        version: { increment: 1 },
      },
    });
    await seedNpcs(townId, regenerated);
    return { applied: true };
  }

  if (effect.kind === "update-npc") {
    const exists = await prisma.npc.findUnique({
      where: { id: effect.npcId },
      select: { id: true },
    });
    if (!exists) return { applied: false, reason: "npc no longer exists" };
    await prisma.npc.update({
      where: { id: effect.npcId },
      data: effect.fields,
    });
    return { applied: true };
  }

  if (effect.kind === "add-npc") {
    // Confirm the building still exists in the town's plot before we
    // attach an orphan NPC.
    const row = await prisma.plotRow.findUnique({ where: { townId } });
    if (!row) return { applied: false, reason: "town has no plot row" };
    const plot = row.json as unknown as Plot;
    const ok = plot.buildings.some((b) => b.id === effect.buildingId);
    if (!ok) {
      return { applied: false, reason: "building no longer in plot" };
    }
    await prisma.npc.create({
      data: {
        townId,
        buildingId: effect.buildingId,
        name: effect.name,
        description: effect.description,
        prompt: effect.prompt,
      },
    });
    // Bump plot version so renderers re-pull NPC roster.
    await prisma.plotRow.update({
      where: { townId },
      data: { version: { increment: 1 } },
    });
    return { applied: true };
  }

  return { applied: false, reason: "unknown effect kind" };
}

/** Find the first instance-suffix variant of `plotKey` (e.g. "studio",
 *  "studio-2", "studio-3", …) that exists in PLOT_PRIORITY and isn't
 *  already in the town's plot. Returns null if the catalog has no room
 *  left for another instance. */
function pickInstanceKey(plotKey: string, plot: Plot): string | null {
  const targetBase = baseKey(plotKey);
  const existing = new Set(plot.buildings.map((b) => b.plotKey));
  for (const key of PLOT_PRIORITY) {
    if (baseKey(key) !== targetBase) continue;
    if (existing.has(key)) continue;
    return key;
  }
  return null;
}

/** Compute the activeCount value to pass to generatePlot so the new
 *  building's slot in PLOT_PRIORITY is included. */
function nextActiveCount(plot: Plot, newKey: string, target: number): number {
  const idx = PLOT_PRIORITY.indexOf(newKey);
  if (idx < 0) return target;
  return Math.max(target, idx + 1, plot.buildings.length + 1);
}
