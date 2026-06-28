// Apply approved CreatorChange rows to the local town folder.
//
// The chat creator stages every mutation server-side as a CreatorChange
// row keyed by tool kind + payload. The apply step here mirrors those
// mutations into the on-disk source of truth (town.json + npcs/*.mdx
// + customPlots/<id>/) so the next `town deploy` reflects them.
//
// We avoid going through `town deploy` from inside this module — the
// command-level wiring runs deploy after we return so failures here
// don't accidentally publish a half-applied state.
//
// `id` generation: NPCs land as `npcs/<cuid>.mdx` so the filename is
// stable across renames. We use a small cuid-ish generator to avoid
// pulling in the full `cuid2` runtime dep.
//
// Image-gen flow: `generate_exterior` / `generate_interior` changes
// carry just a `contentHash`. On apply, we fetch the bytes from
// `/api/sprites/<hash>.png` and write them as
// `customPlots/<customPlotId>/exterior.png` / `interior.png`. The
// matching `add_custom_plot` writes `plot.json` with `./exterior.png` +
// `./interior.png` refs so the existing deploy upload path reuploads
// them via /api/sprites (idempotent on contentHash).
//
// Orphan guard: a `generate_*` change with no matching `add_custom_plot`
// in the same batch (by customPlotId) is silently skipped so a partial
// cancellation can't strand PNGs without a plot.json.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

import {
  readTownJson,
  writeTownJson,
  writeCustomPlot,
  writeNpcMdx,
  type CustomPlotDTO,
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

interface GenerateExteriorPayload {
  customPlotId: string;
  contentHash: string;
  spriteW: number;
  spriteH: number;
}

interface GenerateInteriorPayload {
  customPlotId: string;
  contentHash: string;
  widthTiles: number;
  heightTiles: number;
}

interface AddCustomPlotPayload {
  customPlot: CustomPlotDTO;
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
  // Building id base = plotKey, but with the `custom:` prefix stripped
  // so the on-disk shape matches the core-town convention:
  //   { id: "yc", plotKey: "custom:yc" } — NOT { id: "custom:yc" }.
  // The model's `add_npc({ buildingId })` calls in the same staging
  // batch reference this bare id, so the strip is load-bearing for
  // pairing NPCs to their building. If the id is taken (e.g. two
  // cafés in the same town), we suffix.
  const idBase = payload.plotKey.startsWith("custom:")
    ? payload.plotKey.slice("custom:".length)
    : payload.plotKey;
  let id = idBase;
  let suffix = 2;
  while (town.buildings.some((b) => b.id === id)) {
    id = `${idBase}-${suffix++}`;
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

/** Pull a generated sprite's PNG bytes from the server and write them
 *  to `customPlots/<customPlotId>/<filename>`. Sprite reads are
 *  content-addressed and unauthenticated (see /api/sprites/[hash]) so
 *  we don't thread the PAT through. */
async function fetchSpriteToFile(
  townUrl: string,
  contentHash: string,
  targetPath: string,
): Promise<void> {
  const res = await fetch(`${townUrl}/api/sprites/${contentHash}.png`);
  if (!res.ok) {
    throw new Error(
      `fetch sprite ${contentHash}: ${res.status} ${await res.text()}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(join(targetPath, ".."), { recursive: true });
  await writeFile(targetPath, buf);
}

async function applyGenerateExterior(
  dir: string,
  townUrl: string,
  payload: GenerateExteriorPayload,
): Promise<void> {
  const target = join(
    dir,
    "customPlots",
    payload.customPlotId,
    "exterior.png",
  );
  await fetchSpriteToFile(townUrl, payload.contentHash, target);
}

async function applyGenerateInterior(
  dir: string,
  townUrl: string,
  payload: GenerateInteriorPayload,
): Promise<void> {
  const target = join(
    dir,
    "customPlots",
    payload.customPlotId,
    "interior.png",
  );
  await fetchSpriteToFile(townUrl, payload.contentHash, target);
}

async function applyAddCustomPlot(
  dir: string,
  payload: AddCustomPlotPayload,
): Promise<void> {
  await writeCustomPlot(dir, payload.customPlot);
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/** Apply every change in `changes` to the local town folder, in order.
 *  Each kind maps to one of the mutation tool shapes from
 *  `lib/creator/mutation-tools.ts` + `lib/creator/image-tools.ts`.
 *  Unknown kinds throw so a future tool ships caller-visible feedback
 *  instead of silently no-oping.
 *
 *  `townUrl` is required only for the image-gen kinds (we fetch PNG
 *  bytes from the server). Pass undefined when you know the batch only
 *  contains plain mutations — passing it is also fine.
 *
 *  Orphan-skip: a `generate_exterior` / `generate_interior` change with
 *  no matching `add_custom_plot` (by customPlotId) in this batch is
 *  ignored. Cancelling the plot definition while keeping the image
 *  generations would otherwise strand PNGs in `customPlots/<id>/` with
 *  no `plot.json`, which deploy would then refuse. */
export async function applyChangesLocally(
  dir: string,
  changes: CreatorChange[],
  townUrl?: string,
): Promise<void> {
  // Pre-compute the set of customPlotIds that have a matching
  // add_custom_plot in this batch. generate_* changes outside this set
  // are dropped on the floor.
  const approvedPlotIds = new Set<string>();
  for (const c of changes) {
    if (c.kind === "add_custom_plot") {
      const p = c.payload as AddCustomPlotPayload;
      if (p?.customPlot?.id) approvedPlotIds.add(p.customPlot.id);
    }
  }

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
      case "generate_exterior": {
        const payload = c.payload as GenerateExteriorPayload;
        if (!approvedPlotIds.has(payload.customPlotId)) break;
        if (!townUrl) {
          throw new Error("generate_exterior: townUrl required to fetch sprite bytes");
        }
        await applyGenerateExterior(dir, townUrl, payload);
        break;
      }
      case "generate_interior": {
        const payload = c.payload as GenerateInteriorPayload;
        if (!approvedPlotIds.has(payload.customPlotId)) break;
        if (!townUrl) {
          throw new Error("generate_interior: townUrl required to fetch sprite bytes");
        }
        await applyGenerateInterior(dir, townUrl, payload);
        break;
      }
      case "add_custom_plot":
        await applyAddCustomPlot(dir, c.payload as AddCustomPlotPayload);
        break;
      default:
        throw new Error(`Unknown CreatorChange.kind: ${c.kind}`);
    }
  }
}
