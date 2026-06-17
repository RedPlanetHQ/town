// `town deploy` — push the local town folder back to the server.
//
// Flow:
//   1. Read `town.json` + `customPlots/<id>/plot.json` (each) +
//      `npcs/<id>.mdx` (each).
//   2. For every sprite ref inside a customPlot, classify it:
//        a. "./foo.png"            → resolve to disk, POST bytes to
//                                    /api/sprites, replace the ref with
//                                    "sprite:<contentHash>".
//        b. "sprite:<hash>"        → already uploaded, no-op.
//        c. anything else          → treated as a catalog-relative path;
//                                    server validates against catalog.
//   3. POST /api/town { buildings, customPlots, npcs }.
//
// On any validation failure we abort before mutating server state. The
// /api/town handler runs the same diff/apply pipeline /api/plot's POST
// did before, so the server still owns layout, paths, ponds, decor.

import { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

import { getConfig } from "../config.js";
import {
  readCustomPlots,
  readNpcsDir,
  readTownJson,
  type CustomPlotDTO,
  type LoadedCustomPlot,
} from "../shared/town-io.js";

interface PostBody {
  buildings: Array<{
    id: string;
    plotKey: string;
    variantId?: string;
    label?: string;
    groupChatEnabled?: boolean;
  }>;
  customPlots: CustomPlotDTO[];
  npcs: Array<{
    id?: string;
    buildingId: string;
    slotId: string;
    name: string;
    description: string;
    prompt: string;
  }>;
}

interface PostError {
  error?: string;
  code?: string;
  detail?: string;
  issues?: Array<{ path?: string; message?: string }>;
}

interface SpriteUploadResponse {
  contentHash: string;
  width: number;
  height: number;
  byteSize: number;
}

function isLocalSpriteRef(ref: string): boolean {
  // Local refs are explicitly relative — "./", "../", or "foo/bar.png"
  // where the corresponding file exists relative to the customPlot dir.
  // We're conservative: anything that doesn't look like a "sprite:<hash>"
  // and that does have a file on disk we treat as local.
  return ref.startsWith("./") || ref.startsWith("../");
}

function isUploadedSpriteRef(ref: string): boolean {
  return ref.startsWith("sprite:");
}

async function uploadSprite(
  townUrl: string,
  pat: string,
  pngPath: string,
): Promise<string> {
  const bytes = await readFile(pngPath);
  const res = await fetch(`${townUrl}/api/sprites`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "image/png",
    },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`upload ${pngPath} failed: ${res.status} ${raw}`);
  }
  const parsed = (await res.json()) as SpriteUploadResponse;
  return `sprite:${parsed.contentHash}`;
}

/** Walk every sprite reference inside one CustomPlotDTO and rewrite the
 *  local ones. Returns a new CustomPlotDTO so callers can replace it. */
async function uploadLocalSprites(
  townUrl: string,
  pat: string,
  loaded: LoadedCustomPlot,
  rewriteCache: Map<string, string>,
  log: (msg: string) => void,
): Promise<CustomPlotDTO> {
  const { baseDir, plot } = loaded;

  async function rewrite(ref: string, where: string): Promise<string> {
    if (isUploadedSpriteRef(ref)) return ref;
    if (!isLocalSpriteRef(ref)) return ref; // catalog path, leave alone
    const filePath = isAbsolute(ref) ? ref : resolve(baseDir, ref);
    if (!existsSync(filePath)) {
      throw new Error(`${where}: file not found at ${ref} (resolved to ${filePath})`);
    }
    const cached = rewriteCache.get(filePath);
    if (cached) return cached;
    log(`  ↑ uploading ${ref}`);
    const uploaded = await uploadSprite(townUrl, pat, filePath);
    rewriteCache.set(filePath, uploaded);
    return uploaded;
  }

  const nextInterior = {
    spriteCandidates: await Promise.all(
      plot.interior.spriteCandidates.map((s, i) =>
        rewrite(s, `customPlots/${plot.id}.interior.spriteCandidates[${i}]`),
      ),
    ),
    props: await Promise.all(
      plot.interior.props.map(async (prop, i) => ({
        ...prop,
        sprite: await rewrite(
          prop.sprite,
          `customPlots/${plot.id}.interior.props[${i}].sprite`,
        ),
      })),
    ),
  };

  const nextVariants = await Promise.all(
    plot.variants.map(async (v, i) => ({
      ...v,
      exteriorSpriteCandidates: await Promise.all(
        v.exteriorSpriteCandidates.map((s, j) =>
          rewrite(
            s,
            `customPlots/${plot.id}.variants[${i}].exteriorSpriteCandidates[${j}]`,
          ),
        ),
      ),
    })),
  );

  return {
    ...plot,
    interior: nextInterior,
    variants: nextVariants,
  };
}

async function runDeploy(opts: { dir?: string }): Promise<void> {
  p.intro(chalk.bgCyan(chalk.black(" town deploy ")));

  const cfg = getConfig();
  if (!cfg.auth?.pat || !cfg.auth.townUrl) {
    p.cancel("Not logged in — run `town login` first.");
    process.exit(1);
  }
  const { townUrl, pat } = cfg.auth;

  const dir = resolve(process.cwd(), opts.dir ?? ".");
  if (!existsSync(dir)) {
    p.cancel(`No such folder: ${dir}`);
    process.exit(1);
  }

  // Stage every read up front so we don't half-deploy when one file is
  // malformed.
  let town;
  let customPlots: LoadedCustomPlot[];
  let npcs;
  try {
    town = await readTownJson(dir);
    customPlots = await readCustomPlots(dir);
    npcs = await readNpcsDir(dir);
  } catch (err) {
    p.cancel(err instanceof Error ? err.message : "unknown error reading files");
    process.exit(1);
  }

  if (!Array.isArray(town.buildings) || town.buildings.length === 0) {
    p.cancel("town.json#buildings is empty — every town needs at least HOME.");
    process.exit(1);
  }

  const spinner = p.spinner();

  // 1. Upload local PNGs and rewrite refs.
  let mergedCustomPlots: CustomPlotDTO[];
  try {
    if (customPlots.length > 0) {
      spinner.start(`Uploading sprites for ${customPlots.length} customPlot(s)…`);
      const cache = new Map<string, string>();
      const out: CustomPlotDTO[] = [];
      for (const loaded of customPlots) {
        out.push(
          await uploadLocalSprites(townUrl, pat, loaded, cache, (m) => p.log.message(m)),
        );
      }
      mergedCustomPlots = out;
      spinner.stop(chalk.green(`Uploaded ${cache.size} sprite(s)`));
    } else {
      mergedCustomPlots = town.customPlots ?? [];
    }
  } catch (err) {
    spinner.stop(chalk.red("Sprite upload failed"));
    p.outro(chalk.red(err instanceof Error ? err.message : "unknown error"));
    process.exit(1);
  }

  // 2. POST the consolidated payload.
  const body: PostBody = {
    buildings: town.buildings.map((b) => ({
      id: b.id,
      plotKey: b.plotKey,
      ...(b.variantId ? { variantId: b.variantId } : {}),
      ...(b.label !== undefined ? { label: b.label } : {}),
      ...(b.groupChatEnabled !== undefined
        ? { groupChatEnabled: b.groupChatEnabled }
        : {}),
    })),
    customPlots: mergedCustomPlots,
    npcs,
  };

  spinner.start("Uploading town…");
  const res = await fetch(`${townUrl}/api/town`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let parsed: PostError = {};
    try {
      parsed = (await res.json()) as PostError;
    } catch {
      // ignore
    }
    spinner.stop(chalk.red(`Deploy failed (${res.status})`));
    if (parsed.error) p.log.error(`error: ${parsed.error}`);
    if (parsed.code) p.log.error(`code: ${parsed.code}`);
    if (parsed.detail) p.log.error(parsed.detail);
    if (parsed.issues && parsed.issues.length > 0) {
      p.log.error("Validation issues:");
      for (const issue of parsed.issues) {
        p.log.error(`  • ${issue.path ?? "(root)"}: ${issue.message ?? "?"}`);
      }
    }
    p.outro(chalk.red("Deploy aborted — fix the issues and try again."));
    process.exit(1);
  }
  const data = (await res.json()) as { version: number; count: number };
  spinner.stop(
    chalk.green(
      `Town updated (v${data.version}, ${data.count} NPC row(s) replaced)`,
    ),
  );

  p.outro(chalk.green(`Done. Visit ${townUrl} to see your changes.`));
}

export function registerDeploy(program: Command): void {
  program
    .command("deploy")
    .description("Upload local town.json + customPlots + npcs to the server")
    .option(
      "-d, --dir <path>",
      "Folder containing town.json + customPlots/ + npcs/. Defaults to the current directory.",
    )
    .action(async (opts: { dir?: string }) => {
      await runDeploy(opts);
    });
}
