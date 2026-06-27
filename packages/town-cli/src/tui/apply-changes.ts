// Apply approved CreatorChange rows to the local town folder.
//
// The chat creator stages every mutation server-side as a CreatorChange
// row keyed by tool kind + payload. The apply step here mirrors those
// mutations into the on-disk source of truth (town.json + npcs/*.mdx)
// so the next `town deploy` reflects them.
//
// We avoid going through `town deploy` from inside this module — the
// command-level wiring runs deploy after we return so failures here
// don't accidentally publish a half-applied state.
//
// `id` generation: NPCs land as `npcs/<cuid>.mdx` so the filename is
// stable across renames. We use a small cuid-ish generator to avoid
// pulling in the full `cuid2` runtime dep.

import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

import {
  readTownJson,
  writeTownJson,
  writeNpcMdx,
  type TownBuilding,
} from "../shared/town-io.js";

/** Server-issued CreatorChange row, shape mirrored from
 *  `packages/db/prisma/schema.prisma#CreatorChange`. The payload is the
 *  tool input verbatim; we narrow per `kind` below. */
export interface CreatorChange {
  id: string;
  kind: string;
  payload: unknown;
  summary: string;
}

// -----------------------------------------------------------------------------
// Payload shapes
// -----------------------------------------------------------------------------

interface AddBuildingPayload {
  plotKey: string;
  label?: string;
  variantId?: string;
}

interface DeleteBuildingPayload {
  buildingId: string;
}

interface UpdateBuildingPayload {
  buildingId: string;
  label?: string;
  variantId?: string;
}

interface AddNpcPayload {
  buildingId: string;
  slotId?: string;
  name: string;
  description: string;
  prompt: string;
}

interface UpdateNpcPayload {
  npcId: string;
  name?: string;
  description?: string;
  prompt?: string;
}

interface DeleteNpcPayload {
  npcId: string;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Tiny cuid-ish id — base36 timestamp + 8 random chars. Good enough
 *  for npc filenames and building ids; collisions are not a real
 *  concern at the scale a single town runs at. */
function generateId(prefix = ""): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}-${ts}${rand}` : `${ts}${rand}`;
}

interface NpcRecord {
  /** Absolute path to the file. */
  path: string;
  /** Frontmatter as parsed. */
  data: Record<string, unknown>;
  /** Body (system prompt). */
  body: string;
}

async function readAllNpcs(dir: string): Promise<NpcRecord[]> {
  const npcDir = join(dir, "npcs");
  if (!existsSync(npcDir)) return [];
  const entries = await readdir(npcDir);
  const out: NpcRecord[] = [];
  for (const e of entries) {
    if (!e.endsWith(".mdx") && !e.endsWith(".md")) continue;
    const path = join(npcDir, e);
    const raw = await readFile(path, "utf8");
    const parsed = matter(raw);
    out.push({
      path,
      data: parsed.data as Record<string, unknown>,
      body: parsed.content.trim(),
    });
  }
  return out;
}

async function writeNpcRecord(rec: NpcRecord): Promise<void> {
  const body = matter.stringify(rec.body.trimEnd() + "\n", rec.data);
  await writeFile(rec.path, body);
}

async function findNpcById(dir: string, npcId: string): Promise<NpcRecord | null> {
  const all = await readAllNpcs(dir);
  return all.find((r) => r.data.id === npcId) ?? null;
}

// -----------------------------------------------------------------------------
// Per-kind handlers
// -----------------------------------------------------------------------------

async function applyAddBuilding(
  dir: string,
  payload: AddBuildingPayload,
): Promise<void> {
  const town = await readTownJson(dir);
  // Use the plotKey as the default id when it's not already taken; the
  // server uses the same convention for the day-zero buildings so the
  // creator-generated buildings line up with what `get_current_town`
  // returned to the model. If it IS taken (e.g. two cafés), suffix.
  let id = payload.plotKey;
  let suffix = 2;
  while (town.buildings.some((b) => b.id === id)) {
    id = `${payload.plotKey}-${suffix++}`;
  }
  const entry: TownBuilding = {
    id,
    plotKey: payload.plotKey,
    ...(payload.label ? { label: payload.label } : {}),
    ...(payload.variantId ? { variantId: payload.variantId } : {}),
  };
  await writeTownJson(dir, {
    ...town,
    buildings: [...town.buildings, entry],
  });
}

async function applyDeleteBuilding(
  dir: string,
  payload: DeleteBuildingPayload,
): Promise<void> {
  const town = await readTownJson(dir);
  await writeTownJson(dir, {
    ...town,
    buildings: town.buildings.filter((b) => b.id !== payload.buildingId),
  });
  // Drop any NPC files bound to that building so deploy doesn't ship
  // orphans. We match on the buildingId in the frontmatter rather than
  // the filename so renamed files (e.g. cuid-keyed npcs) still get
  // cleaned.
  const all = await readAllNpcs(dir);
  for (const rec of all) {
    if (rec.data.buildingId === payload.buildingId) {
      await rm(rec.path);
    }
  }
}

async function applyUpdateBuilding(
  dir: string,
  payload: UpdateBuildingPayload,
): Promise<void> {
  const town = await readTownJson(dir);
  const buildings = town.buildings.map((b) =>
    b.id === payload.buildingId
      ? {
          ...b,
          ...(payload.label !== undefined ? { label: payload.label } : {}),
          ...(payload.variantId !== undefined
            ? { variantId: payload.variantId }
            : {}),
        }
      : b,
  );
  await writeTownJson(dir, { ...town, buildings });
}

async function applyAddNpc(
  dir: string,
  payload: AddNpcPayload,
): Promise<void> {
  const id = generateId("npc");
  await writeNpcMdx(dir, {
    id,
    buildingId: payload.buildingId,
    slotId: payload.slotId ?? "",
    name: payload.name,
    description: payload.description,
    prompt: payload.prompt,
  });
}

async function applyUpdateNpc(
  dir: string,
  payload: UpdateNpcPayload,
): Promise<void> {
  const rec = await findNpcById(dir, payload.npcId);
  if (!rec) {
    throw new Error(`update_npc: no NPC with id ${payload.npcId} in npcs/`);
  }
  if (payload.name !== undefined) rec.data.name = payload.name;
  if (payload.description !== undefined) rec.data.description = payload.description;
  if (payload.prompt !== undefined) rec.body = payload.prompt;
  await writeNpcRecord(rec);
}

async function applyDeleteNpc(
  dir: string,
  payload: DeleteNpcPayload,
): Promise<void> {
  const rec = await findNpcById(dir, payload.npcId);
  if (!rec) return; // already gone is fine
  await rm(rec.path);
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/** Apply every change in `changes` to the local town folder, in order.
 *  Each kind maps to one of the six mutation tool shapes from
 *  `lib/creator/mutation-tools.ts`. Unknown kinds throw so a future
 *  tool ships caller-visible feedback instead of silently no-oping. */
export async function applyChangesLocally(
  dir: string,
  changes: CreatorChange[],
): Promise<void> {
  for (const c of changes) {
    switch (c.kind) {
      case "add_building":
        await applyAddBuilding(dir, c.payload as AddBuildingPayload);
        break;
      case "delete_building":
        await applyDeleteBuilding(dir, c.payload as DeleteBuildingPayload);
        break;
      case "update_building":
        await applyUpdateBuilding(dir, c.payload as UpdateBuildingPayload);
        break;
      case "add_npc":
        await applyAddNpc(dir, c.payload as AddNpcPayload);
        break;
      case "update_npc":
        await applyUpdateNpc(dir, c.payload as UpdateNpcPayload);
        break;
      case "delete_npc":
        await applyDeleteNpc(dir, c.payload as DeleteNpcPayload);
        break;
      default:
        throw new Error(`Unknown CreatorChange.kind: ${c.kind}`);
    }
  }
}
