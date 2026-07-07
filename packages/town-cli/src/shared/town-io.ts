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
  /** Optional sign text. When unset the overworld sign falls back to
   *  `id.toUpperCase()` — set this when you want a different casing,
   *  spaces, or punctuation. */
  label?: string;
  /** Turn the per-house group chat on for this building. When true the
   *  interior shows a `[G] Group chat` prompt and players inside the
   *  same house share a multi-party chat with the resident NPCs.
   *  Absent / false → group chat is off for this house. */
  groupChatEnabled?: boolean;
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
  exteriorSprite: string;
  spriteW?: number;
  spriteH?: number;
  /** Legacy single-position slot. Optional — variants that ship
   *  `npcPositions` can omit it. At least one of the two is required. */
  npcPosition?: CustomNpcPositionDTO;
  /** Every NPC slot the variant supports. The CLI binds each
   *  `npcs/<buildingId>__<slotId>.mdx` to the entry with the matching
   *  `id`. Slot ids must be unique within the variant. */
  npcPositions?: CustomNpcPositionDTO[];
}

export interface TileRectDTO {
  tx: number;
  ty: number;
  w: number;
  h: number;
}

export interface TilePosDTO {
  tx: number;
  ty: number;
}

export interface CustomPlotDTO {
  id: string;
  label: string;
  category: string;
  interior: {
    sprite: string;
    props: Array<{ tx: number; ty: number; sprite: string }>;
    widthTiles: number;
    heightTiles: number;
    walkable: TileRectDTO;
    extraWalkable?: TileRectDTO[];
    blocked?: TileRectDTO[];
    spawn: TilePosDTO;
    exit: TilePosDTO;
  };
  variants: CustomVariantDTO[];
}

// -----------------------------------------------------------------------------
// Per-town catalog: visitor tags (inline in town.json) + SVG item templates
// (walked from items/manifest.json + items/<id>.svg). These DTOs mirror
// TownCatalog from @town/types — kept duplicated here because @town/town-cli
// is a published standalone package without workspace deps.
// -----------------------------------------------------------------------------

export interface TownTagDef {
  id: string;
  label: string;
  emoji: string;
  color: string;
  /** null = permanent; otherwise expires after N seconds. */
  defaultTtlSeconds: number | null;
  description: string;
}

export interface TownItemFieldDef {
  name: string;
  label: string;
  maxLength: number;
}

export interface TownItemDef {
  id: string;
  label: string;
  description: string;
  fields: TownItemFieldDef[];
}

/** Wire shape with the SVG body inlined — what `town deploy` sends. */
export interface TownItemBundle extends TownItemDef {
  svg: string;
}

export interface TownJson {
  /** Server-assigned town id. Present after `town new` or `town clone`.
   *  `town deploy` prefers it over the folder name when resolving which
   *  town to push to. Optional only so older local folders predating the
   *  multi-town migration keep loading. Written first in the JSON so a
   *  human opening town.json immediately sees which town this folder is
   *  bound to. */
  id?: string;
  /** One-paragraph welcome pitch shown to the first-time visitor. Free-
   *  form text; keep it short (2-3 sentences). Absent → the welcome
   *  dialogue stays quiet. */
  description?: string;
  buildings: TownBuilding[];
  /** May be omitted at the top level — deploy looks under
   *  `customPlots/<id>/plot.json` for the canonical definitions and
   *  merges them in before sending. */
  customPlots?: CustomPlotDTO[];
  /** Visitor tag definitions. Tiny structured data, inline here. Item
   *  templates are bulkier (SVGs) so they live under `items/` and the CLI
   *  walks that directory. */
  tags?: TownTagDef[];
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
  /** Tool capability grant — integrations, core tasks/memory, skills.
   *  Authored in the MDX frontmatter under `permissions:`; passed
   *  through opaquely here and normalised server-side. Absent means
   *  the NPC has no tools (server stores null → chat runtime reads
   *  zero grants). See townFolderReadme() for the YAML shape. */
  permissions?: unknown;
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
  // Re-order the keys so `id` (when present) lands at the top of the
  // serialised JSON — editors scanning the file in their first screen
  // immediately see which town this folder is bound to. Spread over
  // `rest` (rather than listing known keys) so any field added to
  // TownJson later gets preserved on save instead of silently dropped.
  const { id, ...rest } = town;
  const ordered: TownJson = id !== undefined ? { id, ...rest } : rest;
  await writeJson(join(dir, "town.json"), ordered);
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
    // `permissions` flows through opaquely — we don't validate the
    // shape here, the server runs it through normalisePermissions
    // (drops unknown keys) before persisting.
    const permissions =
      data.permissions !== undefined ? data.permissions : undefined;
    out.push({
      ...(id ? { id } : {}),
      buildingId,
      slotId,
      name,
      description,
      prompt: parsed.content.trim(),
      ...(permissions !== undefined ? { permissions } : {}),
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
    ...(npc.permissions !== undefined ? { permissions: npc.permissions } : {}),
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

// -----------------------------------------------------------------------------
// items/ directory walker — pairs each manifest entry with the matching
// <id>.svg body, validates that every {{placeholder}} in the SVG is declared
// in the manifest entry's `fields` and vice versa. Mismatch is a hard error
// at deploy time so drift is caught locally instead of at runtime.
// -----------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function placeholdersIn(svg: string): Set<string> {
  const out = new Set<string>();
  for (const m of svg.matchAll(PLACEHOLDER_RE)) {
    out.add(m[1]!);
  }
  return out;
}

// Deploy-time hardening for designer-authored SVGs. The viewer page
// renders via <img src=...> (image sandbox, no DOM access), but the
// server-side PNG rasteriser (@napi-rs/canvas) decodes the SVG with
// network access — so an `<image href="https://attacker">` element
// would SSRF on every render. Block the obvious offenders here so the
// deploy fails locally with a useful error instead of shipping the
// payload and silently exfiltrating server identity.
//
// We also forbid placeholders inside script/style blocks and URL
// attributes — the field escaper only handles text-node and attribute
// contexts, and placeholders inside <script> / <style> / href would
// bypass it.

const FORBIDDEN_TAGS = ["script", "foreignObject", "iframe", "object", "embed"];
const URL_ATTRS = ["href", "xlink:href", "src", "action", "formaction"];

function assertSafeSvg(id: string, svg: string): void {
  for (const tag of FORBIDDEN_TAGS) {
    const re = new RegExp(`<\\s*${tag}\\b`, "i");
    if (re.test(svg)) {
      throw new Error(
        `items/${id}.svg contains a <${tag}> element. Forbidden — would execute in the viewer or SSRF the renderer.`,
      );
    }
  }
  // <image href="..."> with an external scheme. Local refs (relative
  // paths, data: URIs, fragment ids) are fine; remote http(s) is not.
  const imageHrefRe = /<\s*image\b[^>]*?\s(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi;
  for (const m of svg.matchAll(imageHrefRe)) {
    const href = m[1]!.trim();
    if (/^https?:\/\//i.test(href)) {
      throw new Error(
        `items/${id}.svg has an <image href="${href}"> pointing at a remote URL. ` +
          `Remote refs would SSRF the PNG renderer — inline the asset as a data: URI or remove it.`,
      );
    }
  }
  // Placeholders inside <script>/<style> or URL attributes get past the
  // field escaper. Reject at deploy so authors must move them into
  // text nodes or harmless attributes.
  const blockRe = /<\s*(script|style)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;
  for (const m of svg.matchAll(blockRe)) {
    if (PLACEHOLDER_RE.test(m[2]!)) {
      PLACEHOLDER_RE.lastIndex = 0;
      throw new Error(
        `items/${id}.svg has a {{placeholder}} inside a <${m[1]}> block. ` +
          `Placeholders are only safe in text nodes and plain attributes.`,
      );
    }
    PLACEHOLDER_RE.lastIndex = 0;
  }
  for (const attr of URL_ATTRS) {
    const attrRe = new RegExp(
      `\\s${attr}\\s*=\\s*["'][^"']*\\{\\{[^}]+\\}\\}[^"']*["']`,
      "gi",
    );
    if (attrRe.test(svg)) {
      throw new Error(
        `items/${id}.svg has a {{placeholder}} inside a ${attr}="..." attribute. ` +
          `Placeholders in URL attributes can produce javascript:/data: scheme injection — keep them in text nodes only.`,
      );
    }
  }
}

export async function readItemsDir(dir: string): Promise<TownItemBundle[]> {
  const root = join(dir, "items");
  if (!existsSync(root)) return [];
  const st = await stat(root);
  if (!st.isDirectory()) return [];
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `items/ exists but has no manifest.json — add one declaring each template's id, label, description, and field schema.`,
    );
  }
  const manifest = await readJson<TownItemDef[]>(manifestPath);
  if (!Array.isArray(manifest)) {
    throw new Error(`items/manifest.json must be a JSON array of item defs.`);
  }
  const out: TownItemBundle[] = [];
  for (const def of manifest) {
    const svgPath = join(root, `${def.id}.svg`);
    if (!existsSync(svgPath)) {
      throw new Error(
        `items/manifest.json declares "${def.id}" but items/${def.id}.svg is missing.`,
      );
    }
    const svg = await readFile(svgPath, "utf8");
    assertSafeSvg(def.id, svg);
    const inSvg = placeholdersIn(svg);
    const declared = new Set(def.fields.map((f) => f.name));
    for (const ph of inSvg) {
      if (!declared.has(ph)) {
        throw new Error(
          `items/${def.id}.svg uses {{${ph}}} but the manifest entry doesn't declare a field with that name.`,
        );
      }
    }
    for (const f of def.fields) {
      if (!inSvg.has(f.name)) {
        throw new Error(
          `items/manifest.json declares field "${f.name}" on "${def.id}" but items/${def.id}.svg has no {{${f.name}}} placeholder.`,
        );
      }
    }
    out.push({ ...def, svg });
  }
  return out;
}

export async function writeItemsDir(
  dir: string,
  items: TownItemBundle[],
): Promise<void> {
  const root = join(dir, "items");
  await mkdir(root, { recursive: true });
  const manifest: TownItemDef[] = items.map(({ svg: _svg, ...rest }) => rest);
  await writeJson(join(root, "manifest.json"), manifest);
  for (const it of items) {
    await writeFile(join(root, `${it.id}.svg`), it.svg);
  }
}
