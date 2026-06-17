// Server-side plot persistence helpers.
//
// One PlotRow per user. The row's `json` is the full Plot from @town/plot.
// When the row doesn't exist yet for a user, we bootstrap by running the
// seeded generator with the user's id as the seed — that gives a stable
// "day-zero" town deterministically tied to the account.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { catalog } from "@town/catalog";
import { generatePlot } from "@town/plot-gen";
import type { Manifest, Plot } from "@town/plot";

import { prisma } from "./db";

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

/** Synthesize a default plot for a brand-new user. The user's id is the
 *  generator seed, so two users always get visually distinct towns and
 *  the same user always sees the same starting layout. */
function bootstrapPlot(userId: string): Plot {
  return generatePlot({
    seed: userId,
    catalog,
    manifest: getManifest(),
    activeCount: 3,            // day-zero trio: home, library, store
    id: `plot-${userId}`,
  });
}

/** Lazy NPC bootstrap. Run from any code path that wants to read NPCs
 *  for a user — covers users whose PlotRow was created before the Npc
 *  table existed. No-op if the user already has at least one Npc row. */
export async function ensureNpcsForUser(userId: string): Promise<void> {
  const count = await prisma.npc.count({ where: { userId } });
  if (count > 0) return;
  const row = await prisma.plotRow.findUnique({ where: { userId } });
  if (!row) return;
  const plot = row.json as unknown as Plot;
  await seedNpcs(userId, plot);
}

export async function getPlotForUser(userId: string): Promise<{ plot: Plot; version: number }> {
  const existing = await prisma.plotRow.findUnique({ where: { userId } });
  if (existing) {
    return { plot: existing.json as unknown as Plot, version: existing.version };
  }
  const plot = bootstrapPlot(userId);
  const row = await prisma.plotRow.create({
    data: { userId, json: plot as unknown as object, version: 1 },
  });
  await seedNpcs(userId, plot);
  return { plot, version: row.version };
}

// Role-specific defaults per building category. The CORE founder is NOT
// here — he's a system fixture loaded from apps/web/src/data/system-npcs/
// and rendered at the store regardless of the user's plot. Every catalog
// plot id should have an entry so a `town deploy` of any plot shape
// yields a functioning NPC roster.
const SEED_TEMPLATES: Record<
  string,
  { description: string; prompt: string }
> = {
  home: {
    description:
      "Butler of the world. Greets you when you come home and remembers what's on your mind.",
    prompt:
      "You are the butler and world runner of this town. You greet the player warmly when they walk in, ask after their day, and reference recent CORE activity when context is provided. Stay in character, never break the fourth wall, and keep replies under three sentences.",
  },
  library: {
    description:
      "Caretaker of the library. Knows what's worth reading next.",
    prompt:
      "You are the keeper of the town library. You suggest reading, remember the player's prior summaries, and speak quietly but warmly. Stay in character; keep replies under three sentences.",
  },
  store: {
    description:
      "Shopkeeper at the corner store. Tracks the market and small talk.",
    prompt:
      "You are the shopkeeper at the town store. You greet the player, mention what's in stock, and keep banter friendly. Stay in character; keep replies under three sentences.",
  },
  office: {
    description:
      "Coworker at the office. Keeps tabs on what the resident is shipping.",
    prompt:
      "You are a coworker at the town office. You greet the player, ask what they're heads-down on today, and chat about ongoing projects when context is provided. Stay in character; keep replies under three sentences.",
  },
  workshop: {
    description:
      "Maker at the workshop. Keeps the tools sharp and the shelves stocked.",
    prompt:
      "You are the maker at the town workshop. You greet the player, ask what they're building, and offer a steady hand. Stay in character; keep replies under three sentences.",
  },
  gym: {
    description:
      "Coach at the gym. Tracks the resident's training streaks.",
    prompt:
      "You are the coach at the town gym. You greet the player, ask about their training, and keep the energy upbeat without being pushy. Stay in character; keep replies under three sentences.",
  },
  studio: {
    description:
      "Studio host. Keeps the practice space ready for the work that matters.",
    prompt:
      "You are the studio host. You greet the player, ask what they're working on, and respect creative focus. Stay in character; keep replies under three sentences.",
  },
};

/** Seed one user-owned NPC per slot in the freshly-generated plot. Walks
 *  `plot.npcs[]` (which already has one entry per variant slot — see
 *  `@town/plot-gen`) and writes a default Npc row for each. Buildings
 *  whose plotKey has no template still skip cleanly.
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
export async function seedNpcs(userId: string, plot: Plot): Promise<void> {
  const data: Array<{
    userId: string;
    buildingId: string;
    slotId: string;
    name: string;
    description: string;
    prompt: string;
  }> = [];
  const buildingsById = new Map(plot.buildings.map((b) => [b.id, b]));
  for (const slot of plot.npcs) {
    const building = buildingsById.get(slot.buildingId);
    if (!building) continue;
    const base = building.plotKey.replace(/-\d+$/, "");
    const tmpl = SEED_TEMPLATES[base];
    if (!tmpl) continue;
    const slotId = slot.slotId ?? "";
    const name =
      slotId === ""
        ? defaultNpcName(building.plotKey)
        : titleCase(slot.label) || titleCase(slotId);
    data.push({
      userId,
      buildingId: building.id,
      slotId,
      name,
      description: tmpl.description,
      prompt: tmpl.prompt,
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

/** Replace a user's plot wholesale. Bumps version so polling clients see
 *  the change on their next request. */
export async function savePlotForUser(userId: string, plot: Plot): Promise<{ version: number }> {
  const row = await prisma.plotRow.upsert({
    where: { userId },
    create: { userId, json: plot as unknown as object, version: 1 },
    update: { json: plot as unknown as object, version: { increment: 1 } },
  });
  return { version: row.version };
}

/** Cheap polling probe — returns just the current version. */
export async function getPlotVersionForUser(userId: string): Promise<number | null> {
  const row = await prisma.plotRow.findUnique({
    where: { userId },
    select: { version: true },
  });
  return row?.version ?? null;
}
