// Server-side plot persistence helpers.
//
// One PlotRow per town. The row's `json` is the full Plot from @town/plot.
// When the row doesn't exist yet for a town, we bootstrap by running the
// seeded generator with the town's id as the seed — that gives a stable
// "day-zero" town deterministically tied to the town id.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { catalog } from "@town/catalog";
import { generatePlot } from "@town/plot-gen";
import type { Manifest, Plot } from "@town/plot";

import { prisma } from "./db";
import { getNpcTemplate } from "./npc-templates";

// Load + cache the extras manifest. It's a small JSON shipped under the
// webapp's public dir; the server reads it once.
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

/** Synthesize a default plot for a brand-new town. The town's id is the
 *  generator seed, so two towns always get visually distinct layouts and
 *  the same town always sees the same starting layout. */
function bootstrapPlot(townId: string): Plot {
  return generatePlot({
    seed: townId,
    catalog,
    manifest: getManifest(),
    activeCount: 3,            // day-zero trio: home, library, store
    id: `plot-${townId}`,
  });
}

/** Lazy NPC bootstrap. Run from any code path that wants to read NPCs
 *  for a town — covers towns whose PlotRow was created before the Npc
 *  table existed. No-op if the town already has at least one Npc row. */
export async function ensureNpcsForTown(townId: string): Promise<void> {
  const count = await prisma.npc.count({ where: { townId } });
  if (count > 0) return;
  const row = await prisma.plotRow.findUnique({ where: { townId } });
  if (!row) return;
  const plot = row.json as unknown as Plot;
  await seedNpcs(townId, plot);
}

export async function getPlotForTown(townId: string): Promise<{ plot: Plot; version: number }> {
  const existing = await prisma.plotRow.findUnique({ where: { townId } });
  if (existing) {
    return { plot: existing.json as unknown as Plot, version: existing.version };
  }
  const plot = bootstrapPlot(townId);
  const row = await prisma.plotRow.create({
    data: { townId, json: plot as unknown as object, version: 1 },
  });
  await seedNpcs(townId, plot);
  return { plot, version: row.version };
}

/** Seed one town-owned NPC per slot in the freshly-generated plot. Walks
 *  `plot.npcs[]` (which already has one entry per variant slot — see
 *  `@town/plot-gen`) and writes a default Npc row for each. Buildings
 *  whose plotKey has no template still skip cleanly.
 *
 *  Template source: apps/web/src/data/npc-templates/<plotKey>.mdx. The MDX
 *  carries the description, system prompt, and capability grants
 *  (permissions JSON) for the archetype.
 *
 *  Name strategy: the default slot ("") uses the per-plotKey name pool
 *  (so HOME at "home" gets Hudson, the second instance gets Hattie,
 *  etc). Named slots fall back to the slot's `label` from the variant —
 *  so a barista slot reads "Barista" until the user authors an MDX.
 *
 *  The CORE founder is system-owned (see
 *  apps/web/src/data/system-npcs/core-founder.mdx) and is NOT written here.
 *
 *  Idempotent — uses `createMany({ skipDuplicates: true })` keyed on the
 *  Npc PK, so re-running is safe. */
export async function seedNpcs(townId: string, plot: Plot): Promise<void> {
  const data: Array<{
    townId: string;
    buildingId: string;
    slotId: string;
    name: string;
    description: string;
    prompt: string;
    permissions: object;
  }> = [];
  const buildingsById = new Map(plot.buildings.map((b) => [b.id, b]));
  for (const slot of plot.npcs) {
    const building = buildingsById.get(slot.buildingId);
    if (!building) continue;
    const template = getNpcTemplate(building.plotKey);
    if (!template) continue;
    const slotId = slot.slotId ?? "";
    const name =
      slotId === ""
        ? defaultNpcName(building.plotKey)
        : titleCase(slot.label) || titleCase(slotId);
    data.push({
      townId,
      buildingId: building.id,
      slotId,
      name,
      description: template.description,
      prompt: template.prompt,
      permissions: template.permissions as object,
    });
  }
  if (data.length === 0) return;
  await prisma.npc.createMany({ data, skipDuplicates: true });
}

function titleCase(s: string): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Per-plot name pool. First entry is used for the base plot ("home"),
// next entries for instance suffixes ("home-2" → 2nd, "home-3" → 3rd, …).
// If the suffix outruns the pool we cycle, so even tier-3 instances get
// a coherent name instead of the bare plot key.
const NPC_NAME_POOL: Record<string, string[]> = {
  home:     ["Hudson", "Hattie", "Hollis", "Hazel", "Harlow"],
  library:  ["Lior", "Linnea", "Leona", "Lev", "Lumi"],
  store:    ["Sera", "Solenn", "Soren", "Stella", "Sable"],
  office:   ["Otto", "Odette", "Oren", "Ovi", "Olive"],
  workshop: ["Wren", "Wolfe", "Wilma", "Wynn", "Walden"],
  cafe:     ["Cosma", "Caleb", "Cassia", "Clio", "Cyrus"],
  studio:   ["Stellan", "Sasha", "Sage", "Solveig", "Sven"],
  gym:      ["Greta", "Gus", "Guthrie", "Gemma", "Gideon"],
  stage:    ["Aria", "Aurelio", "Anouk", "Astor", "Amaya"],
  practice: ["Pria", "Pablo", "Pernille", "Phaedra", "Piet"],
  station:  ["Casey", "Corin", "Cael", "Cleo", "Crispin"],
};

function defaultNpcName(plotKey: string): string {
  const base = plotKey.replace(/-\d+$/, "");
  const suffixMatch = plotKey.match(/-(\d+)$/);
  // "home" → 0, "home-2" → 1, "home-3" → 2, ...
  const idx = suffixMatch ? parseInt(suffixMatch[1]!, 10) - 1 : 0;
  const pool = NPC_NAME_POOL[base];
  if (pool && pool.length) {
    return pool[idx % pool.length]!;
  }
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Replace a town's plot wholesale. Bumps version so polling clients see
 *  the change on their next request. */
export async function savePlotForTown(townId: string, plot: Plot): Promise<{ version: number }> {
  const row = await prisma.plotRow.upsert({
    where: { townId },
    create: { townId, json: plot as unknown as object, version: 1 },
    update: { json: plot as unknown as object, version: { increment: 1 } },
  });
  return { version: row.version };
}

/** Cheap polling probe — returns just the current version. */
export async function getPlotVersionForTown(townId: string): Promise<number | null> {
  const row = await prisma.plotRow.findUnique({
    where: { townId },
    select: { version: true },
  });
  return row?.version ?? null;
}
