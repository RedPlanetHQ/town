// Shared scaffold routines used by `town new` (greenfield creation) and
// `town clone` (pull an existing town locally). Extracted from the old
// `town init` so both code paths share validation, sprite-overwrite
// confirmation, and town.json shaping.
//
// Both routines accept the server-side town `id` from the caller and
// stash it in `town.json` — that's how later commands (deploy, creator
// chat) resolve back to the authoritative town when the local folder
// name diverges from the slug.

import * as p from "@clack/prompts";
import chalk from "chalk";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { townFolderReadme } from "./readme.js";
import { fetchCoreWorkspace, writeDefaultNpcs } from "./seed-npcs.js";
import {
  writeCustomPlot,
  writeItemsDir,
  writeNpcMdx,
  writeTownJson,
  type CustomPlotDTO,
  type NpcDTO,
  type TownBuilding,
  type TownItemBundle,
  type TownTagDef,
} from "./town-io.js";

export interface TownGetResponse {
  /** Server populates this on /api/town?slug=… so the CLI can stash it
   *  in town.json on clone. */
  id?: string;
  buildings: TownBuilding[];
  customPlots: CustomPlotDTO[];
  npcs: Array<NpcDTO & { id: string }>;
  version: number;
  catalog?: {
    tags: TownTagDef[];
    items: TownItemBundle[];
  };
}

interface DefaultBuilding {
  id: string;
  plotKey: string;
}

const DEFAULT_BUILDINGS: DefaultBuilding[] = [
  { id: "home", plotKey: "home" },
  { id: "library", plotKey: "library" },
  { id: "store", plotKey: "store" },
];

export async function getJson<T>(url: string, pat: string): Promise<T> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${pat}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(
  url: string,
  pat: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let parsed: { error?: string } = {};
    try {
      parsed = (await res.json()) as { error?: string };
    } catch {
      // ignore
    }
    throw new Error(
      `POST ${url} → ${res.status} ${parsed.error ?? "unknown error"}`,
    );
  }
  return (await res.json()) as T;
}

/** Confirm before overwriting a target folder that already has reserved
 *  files — keeps the user from blowing away a town they were editing. */
export async function ensureSlugDir(
  targetDir: string,
  slug: string,
): Promise<void> {
  if (!existsSync(targetDir)) {
    await mkdir(targetDir, { recursive: true });
    return;
  }
  const entries = await readdir(targetDir);
  const reserved = new Set([
    "town.json",
    "plot.json",
    "README.md",
    // legacy filenames the older CLI used to drop here — keep them in
    // the conflict set so re-running over an old folder still prompts.
    "AGENTS.md",
    "catalog.json",
    "manifest.json",
    "npcs",
    "customPlots",
  ]);
  const conflicts = entries.filter((e) => reserved.has(e));
  if (conflicts.length === 0) return;
  const ok = (await p.confirm({
    message: `${slug}/ already has ${conflicts.join(", ")} — overwrite?`,
    initialValue: false,
  })) as boolean;
  if (!ok) {
    p.cancel("Aborted");
    process.exit(1);
  }
}

/** Greenfield scaffold — day-zero trio, default NPCs, README. */
export async function scaffoldNew(
  pat: string,
  targetDir: string,
  coreUrl: string,
  townId: string,
): Promise<void> {
  await writeTownJson(targetDir, {
    id: townId,
    buildings: DEFAULT_BUILDINGS,
  });
  await mkdir(join(targetDir, "customPlots"), { recursive: true });

  // Default NPC roster — Hudson at home, Lior at the library, Sera at
  // the store. HOME's butler name is bound to the resident's CORE
  // workspace when we can fetch it; this matches the runtime override
  // the renderer applies, so the editable name in the .mdx file lines
  // up with what the player sees in-game from day zero.
  const spinner = p.spinner();
  spinner.start("Fetching workspace name…");
  const workspace = await fetchCoreWorkspace(coreUrl, pat);
  spinner.stop(
    workspace
      ? chalk.green(`Butler name set to ${workspace.name}`)
      : chalk.yellow("Workspace lookup skipped — butler defaults to Hudson"),
  );
  await writeDefaultNpcs(targetDir, workspace?.name ?? null);

  await writeFile(join(targetDir, "README.md"), townFolderReadme());
}

/** Pull an existing town off the server (via `/api/town?slug=<slug>`)
 *  and materialize the local folder. The server response's `id` is
 *  preferred when present; the caller supplies a fallback for older
 *  servers that don't echo it. */
export async function cloneExisting(
  townUrl: string,
  pat: string,
  targetDir: string,
  slug: string,
  fallbackTownId: string,
): Promise<TownGetResponse> {
  const spinner = p.spinner();
  spinner.start("Fetching town…");
  const town = await getJson<TownGetResponse>(
    `${townUrl}/api/town?slug=${encodeURIComponent(slug)}`,
    pat,
  );
  const catalogTags = town.catalog?.tags ?? [];
  const catalogItems = town.catalog?.items ?? [];
  spinner.stop(
    chalk.green(
      `Fetched town v${town.version} — ${town.buildings.length} building(s), ` +
        `${town.customPlots.length} customPlot(s), ${town.npcs.length} NPC(s)` +
        (town.catalog
          ? `, ${catalogTags.length} tag(s), ${catalogItems.length} item template(s)`
          : ""),
    ),
  );

  // Tags get inlined into town.json so editors see them next to the
  // buildings list. Items go into items/ as a manifest.json plus one
  // .svg per template so designers keep file-level workflows.
  await writeTownJson(targetDir, {
    id: town.id ?? fallbackTownId,
    buildings: town.buildings,
    ...(catalogTags.length > 0 ? { tags: catalogTags } : {}),
  });
  await mkdir(join(targetDir, "customPlots"), { recursive: true });
  for (const cp of town.customPlots) {
    await writeCustomPlot(targetDir, cp);
  }
  await mkdir(join(targetDir, "npcs"), { recursive: true });
  for (const npc of town.npcs) {
    await writeNpcMdx(targetDir, npc);
  }
  if (catalogItems.length > 0) {
    await writeItemsDir(targetDir, catalogItems);
  }
  await writeFile(join(targetDir, "README.md"), townFolderReadme());

  return town;
}
