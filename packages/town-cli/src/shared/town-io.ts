// Shared filesystem layout for `town clone` and `town deploy`. The two
// commands read/write the same set of files — clone hydrates from the
// server, deploy reads what's there and pushes it back.

import matter from "gray-matter";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface TownBuilding {
  id: string;
  plotKey: string;
  variantId?: string;
}

export interface CustomNpcPositionDTO {
  /** Stable slot id within the variant. Empty string is the implicit
   *  first slot — what an MDX without a `slotId` frontmatter binds to. */
  id?: string;
  tx: number;
  ty: number;
  label: string;
}

export interface CustomVariantDTO {
  id: string;
  exteriorSpriteCandidates: string[];
  /** Legacy single-position slot. Optional — variants that ship
   *  `npcPositions` can omit it. At least one of the two is required. */
  npcPosition?: CustomNpcPositionDTO;
  /** Every NPC slot the variant supports. The CLI binds each
   *  `npcs/<buildingId>__<slotId>.mdx` to the entry with the matching
   *  `id`. Slot ids must be unique within the variant. */
  npcPositions?: CustomNpcPositionDTO[];
}

export interface CustomPlotDTO {
  id: string;
  label: string;
  category: string;
  interior: {
    spriteCandidates: string[];
    props: Array<{ tx: number; ty: number; sprite: string }>;
  };
  variants: CustomVariantDTO[];
}

export interface TownJson {
  buildings: TownBuilding[];
  /** May be omitted at the top level — deploy looks under
   *  `customPlots/<id>/plot.json` for the canonical definitions and
   *  merges them in before sending. */
  customPlots?: CustomPlotDTO[];
}

export interface NpcDTO {
  id?: string;
  buildingId: string;
  /** Slot within the building. Empty string is the implicit first slot
   *  — what an MDX without a `slotId` frontmatter binds to. */
  slotId: string;
  name: string;
  description: string;
  prompt: string;
}

export async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

export async function readTownJson(dir: string): Promise<TownJson> {
  const path = join(dir, "town.json");
  if (!existsSync(path)) {
    throw new Error(`No town.json in ${dir} — run \`town init\` or \`town clone\` first.`);
  }
  return readJson<TownJson>(path);
}

export async function writeTownJson(dir: string, town: TownJson): Promise<void> {
  await writeJson(join(dir, "town.json"), town);
}

/** Parse a slotId hint from an MDX filename. We use the convention
 *  `<buildingId>__<slotId>.mdx` so the file listing is meaningful when
 *  you have two NPCs in the same building. Frontmatter wins if both are
 *  set; a missing slot resolves to "" (the implicit first slot). */
function slotIdFromFilename(file: string): { buildingId: string; slotId: string } {
  const base = file.replace(/\.(md|mdx)$/i, "");
  const idx = base.indexOf("__");
  if (idx === -1) return { buildingId: base, slotId: "" };
  return { buildingId: base.slice(0, idx), slotId: base.slice(idx + 2) };
}

export async function readNpcsDir(dir: string): Promise<NpcDTO[]> {
  const npcDir = join(dir, "npcs");
  if (!existsSync(npcDir)) return [];
  const st = await stat(npcDir);
  if (!st.isDirectory()) return [];
  const entries = await readdir(npcDir);
  const mdx = entries.filter((e) => e.endsWith(".mdx") || e.endsWith(".md"));
  const out: NpcDTO[] = [];
  for (const file of mdx) {
    const raw = await readFile(join(npcDir, file), "utf8");
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const fromFilename = slotIdFromFilename(file);
    const buildingId =
      typeof data.buildingId === "string" ? data.buildingId : fromFilename.buildingId;
    const slotId =
      typeof data.slotId === "string" ? data.slotId : fromFilename.slotId;
    const name = typeof data.name === "string" ? data.name : "";
    const description =
      typeof data.description === "string" ? data.description : "";
    const id = typeof data.id === "string" ? data.id : undefined;
    if (!buildingId) {
      throw new Error(
        `${file}: frontmatter missing \`buildingId\` — can't decide which building this NPC lives in.`,
      );
    }
    if (!name) throw new Error(`${file}: frontmatter missing \`name\`.`);
    out.push({
      ...(id ? { id } : {}),
      buildingId,
      slotId,
      name,
      description,
      prompt: parsed.content.trim(),
    });
  }
  return out;
}

export async function writeNpcMdx(
  dir: string,
  npc: NpcDTO & { id: string },
): Promise<void> {
  const npcDir = join(dir, "npcs");
  await mkdir(npcDir, { recursive: true });
  const safeBuilding = npc.buildingId.replace(/[^a-z0-9_-]+/gi, "-");
  // Filename convention: <buildingId>.mdx for the default first slot,
  // <buildingId>__<slotId>.mdx for any other slot. Keeps the legacy
  // shape on disk when no multi-slot variant is in play.
  const slotSafe = (npc.slotId ?? "").replace(/[^a-z0-9_-]+/gi, "-");
  const safe = slotSafe ? `${safeBuilding}__${slotSafe}` : safeBuilding;
  const body = matter.stringify(npc.prompt.trimEnd() + "\n", {
    id: npc.id,
    buildingId: npc.buildingId,
    ...(npc.slotId ? { slotId: npc.slotId } : {}),
    name: npc.name,
    description: npc.description,
  });
  await writeFile(join(npcDir, `${safe}.mdx`), body);
}

/** Read every customPlots/<id>/plot.json under `dir`. Each plot.json may
 *  carry relative sprite paths like "./exterior.png" — the deploy step
 *  resolves those into absolute filesystem paths for upload before
 *  rewriting refs. Returns each entry alongside its source folder so
 *  callers can locate sibling PNGs. */
export interface LoadedCustomPlot {
  /** Filesystem path to the customPlots/<id> directory. */
  baseDir: string;
  /** Relative form, for log messages. */
  baseDirRel: string;
  plot: CustomPlotDTO;
}

export async function readCustomPlots(dir: string): Promise<LoadedCustomPlot[]> {
  const root = join(dir, "customPlots");
  if (!existsSync(root)) return [];
  const st = await stat(root);
  if (!st.isDirectory()) return [];
  const entries = await readdir(root);
  const out: LoadedCustomPlot[] = [];
  for (const entry of entries) {
    const baseDir = join(root, entry);
    const childStat = await stat(baseDir);
    if (!childStat.isDirectory()) continue;
    const plotPath = join(baseDir, "plot.json");
    if (!existsSync(plotPath)) continue;
    const plot = await readJson<CustomPlotDTO>(plotPath);
    out.push({
      baseDir,
      baseDirRel: relative(dir, baseDir),
      plot,
    });
  }
  return out;
}

export async function writeCustomPlot(
  dir: string,
  cp: CustomPlotDTO,
): Promise<void> {
  const baseDir = join(dir, "customPlots", cp.id);
  await mkdir(baseDir, { recursive: true });
  await writeJson(join(baseDir, "plot.json"), cp);
}
