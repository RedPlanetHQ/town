// `town init` — bootstrap a local edit folder against the user's town.
//
// Two modes, decided by what's on the server:
//
//   1. No town yet → prompt for a name, POST /api/towns/me to create
//      one, then scaffold a default folder named after the new slug
//      with the day-zero trio.
//
//   2. Town already exists → confirm with the user, then clone the
//      server state into a folder named after the existing slug.
//
// In both cases the folder lives at `<cwd>/<slug>/`. The CLI never
// touches paths/ponds/decor — only `town.json`, `customPlots/`, and
// `npcs/`. Catalog + manifest snapshots are written alongside as
// read-only reference for editors.

import { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

import { getConfig } from "../config.js";
import { agentsMarkdown } from "../shared/agents-md.js";
import { summarizeCatalog } from "../shared/catalog-summary.js";
import {
  writeCustomPlot,
  writeNpcMdx,
  writeTownJson,
  type CustomPlotDTO,
  type NpcDTO,
  type TownBuilding,
} from "../shared/town-io.js";

interface TownsMeResponse {
  town: { id: string; slug: string; name: string } | null;
}

interface TownsMeCreate {
  town: { id: string; slug: string; name: string };
}

interface TownsMeError {
  error?: string;
}

interface TownGetResponse {
  buildings: TownBuilding[];
  customPlots: CustomPlotDTO[];
  npcs: Array<NpcDTO & { id: string }>;
  version: number;
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

async function getJson<T>(url: string, pat: string): Promise<T> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${pat}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(url: string, pat: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let parsed: TownsMeError = {};
    try {
      parsed = (await res.json()) as TownsMeError;
    } catch {
      // ignore
    }
    throw new Error(
      `POST ${url} → ${res.status} ${parsed.error ?? "unknown error"}`,
    );
  }
  return (await res.json()) as T;
}

async function getPublic(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return await res.json();
}

async function ensureSlugDir(targetDir: string, slug: string): Promise<void> {
  if (!existsSync(targetDir)) {
    await mkdir(targetDir, { recursive: true });
    return;
  }
  const entries = await readdir(targetDir);
  const reserved = new Set([
    "town.json",
    "plot.json",
    "catalog.json",
    "manifest.json",
    "AGENTS.md",
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

async function writeCatalogSnapshot(townUrl: string, targetDir: string): Promise<void> {
  const spinner = p.spinner();
  spinner.start("Fetching catalog + manifest…");
  try {
    const rawCatalog = await getPublic(`${townUrl}/sprites/catalog/variants.json`);
    const manifest = await getPublic(`${townUrl}/sprites/extras/MANIFEST.json`);
    // Slim projection — only the fields a town editor (human or coding
    // agent) needs to author `town.json` / customPlots. Drops prose
    // (vibe, profession, anchorObjects, triggers, paletteAccent) that
    // the server doesn't read back from the folder.
    const catalog = summarizeCatalog(rawCatalog);
    await writeFile(
      join(targetDir, "catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );
    await writeFile(
      join(targetDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    spinner.stop(chalk.green("Fetched catalog + manifest"));
  } catch (e) {
    spinner.stop(
      chalk.yellow(
        `Catalog/manifest fetch skipped (${e instanceof Error ? e.message : "unknown"})`,
      ),
    );
  }
}

async function scaffoldNew(
  townUrl: string,
  pat: string,
  targetDir: string,
): Promise<void> {
  await writeTownJson(targetDir, {
    buildings: DEFAULT_BUILDINGS,
    customPlots: [],
  });
  await mkdir(join(targetDir, "npcs"), { recursive: true });
  await mkdir(join(targetDir, "customPlots"), { recursive: true });
  await writeCatalogSnapshot(townUrl, targetDir);
  await writeFile(join(targetDir, "AGENTS.md"), agentsMarkdown());
  void pat;
}

async function cloneExisting(
  townUrl: string,
  pat: string,
  targetDir: string,
): Promise<TownGetResponse> {
  const spinner = p.spinner();
  spinner.start("Fetching town…");
  const town = await getJson<TownGetResponse>(`${townUrl}/api/town`, pat);
  spinner.stop(
    chalk.green(
      `Fetched town v${town.version} — ${town.buildings.length} building(s), ` +
        `${town.customPlots.length} customPlot(s), ${town.npcs.length} NPC(s)`,
    ),
  );

  await writeTownJson(targetDir, {
    buildings: town.buildings,
    customPlots: [],
  });
  await mkdir(join(targetDir, "customPlots"), { recursive: true });
  for (const cp of town.customPlots) {
    await writeCustomPlot(targetDir, cp);
  }
  await mkdir(join(targetDir, "npcs"), { recursive: true });
  for (const npc of town.npcs) {
    await writeNpcMdx(targetDir, npc);
  }
  await writeCatalogSnapshot(townUrl, targetDir);
  await writeFile(join(targetDir, "AGENTS.md"), agentsMarkdown());

  return town;
}

async function runInit(): Promise<void> {
  p.intro(chalk.bgCyan(chalk.black(" town init ")));

  const cfg = getConfig();
  if (!cfg.auth?.pat || !cfg.auth.townUrl) {
    p.cancel("Not logged in — run `town login` first.");
    process.exit(1);
  }
  const { townUrl, pat } = cfg.auth;

  // 1. Check ownership.
  const spinner = p.spinner();
  spinner.start("Checking for an existing town…");
  let me: TownsMeResponse;
  try {
    me = await getJson<TownsMeResponse>(`${townUrl}/api/towns/me`, pat);
  } catch (err) {
    spinner.stop(chalk.red("Could not reach the town server"));
    p.outro(chalk.red(err instanceof Error ? err.message : "unknown error"));
    process.exit(1);
  }
  spinner.stop(
    me.town
      ? chalk.green(`Found existing town: ${me.town.name} (/${me.town.slug})`)
      : chalk.cyan("No town yet — let's create one"),
  );

  // 2. Existing → confirm clone; missing → confirm create.
  let town: { id: string; slug: string; name: string };
  let mode: "create" | "clone";

  if (me.town) {
    mode = "clone";
    const ok = (await p.confirm({
      message: `Clone ${me.town.name} into ./${me.town.slug}/?`,
      initialValue: true,
    })) as boolean;
    if (p.isCancel(ok) || !ok) {
      p.cancel("init cancelled");
      return;
    }
    town = me.town;
  } else {
    mode = "create";
    const proceed = (await p.confirm({
      message: "You don't have a town yet. Create one?",
      initialValue: true,
    })) as boolean;
    if (p.isCancel(proceed) || !proceed) {
      p.cancel("init cancelled");
      return;
    }
    const name = (await p.text({
      message: "Town name",
      placeholder: "My Town",
      validate: (v) =>
        v && v.trim().length > 0 ? undefined : "Name can't be empty",
    })) as string;
    if (p.isCancel(name)) {
      p.cancel("init cancelled");
      return;
    }

    const createSpinner = p.spinner();
    createSpinner.start("Creating town on the server…");
    let created: TownsMeCreate;
    try {
      created = await postJson<TownsMeCreate>(
        `${townUrl}/api/towns/me`,
        pat,
        { name: name.trim() },
      );
    } catch (err) {
      createSpinner.stop(chalk.red("Town creation failed"));
      p.outro(chalk.red(err instanceof Error ? err.message : "unknown error"));
      process.exit(1);
    }
    createSpinner.stop(
      chalk.green(`Created ${created.town.name} (/${created.town.slug})`),
    );
    town = created.town;
  }

  // 3. Materialize into <cwd>/<slug>/.
  const targetDir = resolve(process.cwd(), town.slug);
  await ensureSlugDir(targetDir, town.slug);

  if (mode === "create") {
    await scaffoldNew(townUrl, pat, targetDir);
    p.log.success(`Scaffolded ./${town.slug}/ with the day-zero trio`);
    p.outro(
      chalk.green(
        `Edit ${town.slug}/town.json (+ customPlots / npcs), then run \`town deploy\` from inside ${town.slug}/.`,
      ),
    );
  } else {
    await cloneExisting(townUrl, pat, targetDir);
    p.log.success(`Cloned town into ./${town.slug}/`);
    p.outro(
      chalk.green(
        `Edit, then run \`town deploy\` from inside ${town.slug}/.`,
      ),
    );
  }
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description(
      "Create a new town (or clone your existing one) into <slug>/ under the current folder",
    )
    .action(async () => {
      await runInit();
    });
}
