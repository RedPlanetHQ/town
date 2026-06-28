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
  readItemsDir,
  readNpcsDir,
  readTownJson,
  type CustomPlotDTO,
  type LoadedCustomPlot,
  type TownItemBundle,
  type TownTagDef,
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
    permissions?: unknown;
  }>;
  /** Per-town catalog. Omitted when the deployment has neither inline
   *  `tags` nor an `items/` directory — server treats absence as "leave
   *  the existing catalog alone" so a partial deploy doesn't wipe content. */
  catalog?: {
    tags: TownTagDef[];
    items: TownItemBundle[];
  };
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
    ...plot.interior,
    sprite: await rewrite(
      plot.interior.sprite,
      `customPlots/${plot.id}.interior.sprite`,
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
      exteriorSprite: await rewrite(
        v.exteriorSprite,
        `customPlots/${plot.id}.variants[${i}].exteriorSprite`,
      ),
    })),
  );

  return {
    ...plot,
    interior: nextInterior,
    variants: nextVariants,
  };
}

export interface RunDeployOpts {
  dir?: string;
  reflow?: boolean;
  /** Explicit slug — wins over the local town.json's `id` and the
   *  folder name. Used when the user is operating on a town from
   *  outside its folder, or to disambiguate across multiple owned
   *  towns. */
  slug?: string;
  /** Internal — appended to /api/town as `?from=creator` so the server
   *  brackets the deploy in a renovating/active status flip. The chat
   *  surface's approve flow sets this; ordinary `town deploy` leaves
   *  it undefined. */
  from?: "creator";
}

export interface RunDeployQuietOpts {
  dir: string;
  reflow?: boolean;
  slug?: string;
  from?: "creator";
  /** Reports progress phases without ever writing to stdout. The chat
   *  surface uses this to drive an inline status message instead of
   *  letting clack-prompts corrupt the Ink frame. */
  onPhase?: (phase:
    | "reading"
    | "uploading-sprites"
    | "uploading-town"
    | "done") => void;
}

export interface RunDeployQuietResult {
  version: number;
  count: number;
}

/** Internal deploy used by the chat-creator's Approve flow. Same
 *  pipeline as `runDeploy` but with all clack-prompts / process.exit
 *  calls stripped — the caller decides how to surface errors. Never
 *  writes to stdout; safe to invoke from inside an Ink render tree. */
export async function runDeployQuiet(
  opts: RunDeployQuietOpts,
): Promise<RunDeployQuietResult> {
  const cfg = getConfig();
  if (!cfg.auth?.pat || !cfg.auth.townUrl) {
    throw new Error("Not logged in — run `town login` first.");
  }
  const { townUrl, pat } = cfg.auth;

  if (!existsSync(opts.dir)) {
    throw new Error(`No such folder: ${opts.dir}`);
  }

  opts.onPhase?.("reading");
  const town = await readTownJson(opts.dir);
  const customPlots = await readCustomPlots(opts.dir);
  const npcs = await readNpcsDir(opts.dir);
  const items = await readItemsDir(opts.dir);

  let slug = opts.slug;
  if (!slug && town.id) {
    try {
      const mine = await fetch(`${townUrl}/api/towns/mine`, {
        headers: { authorization: `Bearer ${pat}` },
      });
      if (mine.ok) {
        const body = (await mine.json()) as {
          towns?: Array<{ id: string; slug: string }>;
        };
        const found = body.towns?.find((t) => t.id === town.id);
        if (found) slug = found.slug;
      }
    } catch {
      // fall through to folder-name fallback
    }
  }
  if (!slug) slug = opts.dir.split("/").pop() ?? undefined;

  if (!Array.isArray(town.buildings) || town.buildings.length === 0) {
    throw new Error("town.json#buildings is empty — every town needs at least HOME.");
  }

  let mergedCustomPlots: CustomPlotDTO[];
  if (customPlots.length > 0) {
    opts.onPhase?.("uploading-sprites");
    const cache = new Map<string, string>();
    const out: CustomPlotDTO[] = [];
    for (const loaded of customPlots) {
      // Quiet sprite upload — discard log messages. The chat surface
      // only cares about phase boundaries, not per-file progress.
      out.push(
        await uploadLocalSprites(townUrl, pat, loaded, cache, () => {}),
      );
    }
    mergedCustomPlots = out;
  } else {
    mergedCustomPlots = town.customPlots ?? [];
  }

  const hasCatalog = (town.tags && town.tags.length > 0) || items.length > 0;
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
    ...(hasCatalog
      ? { catalog: { tags: town.tags ?? [], items } }
      : {}),
  };

  opts.onPhase?.("uploading-town");
  const params = new URLSearchParams();
  if (slug) params.set("slug", slug);
  if (opts.reflow) params.set("reflow", "1");
  if (opts.from) params.set("from", opts.from);
  const qs = params.toString();
  const url = qs ? `${townUrl}/api/town?${qs}` : `${townUrl}/api/town`;
  const res = await fetch(url, {
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
    const msg = parsed.detail ?? parsed.error ?? `HTTP ${res.status}`;
    throw new Error(`Deploy failed: ${msg}`);
  }
  const data = (await res.json()) as { version: number; count: number };
  opts.onPhase?.("done");
  return data;
}

export async function runDeploy(opts: RunDeployOpts): Promise<void> {
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
  let items: TownItemBundle[];
  try {
    town = await readTownJson(dir);
    customPlots = await readCustomPlots(dir);
    npcs = await readNpcsDir(dir);
    items = await readItemsDir(dir);
  } catch (err) {
    p.cancel(err instanceof Error ? err.message : "unknown error reading files");
    process.exit(1);
  }

  // Resolve the slug. Order: explicit flag → town.json#id reverse-lookup
  // via /api/towns/mine → folder name. Resolving here keeps the URL
  // composition step further down agnostic of how we got the slug.
  let slug = opts.slug;
  if (!slug && town.id) {
    try {
      const mine = await fetch(`${townUrl}/api/towns/mine`, {
        headers: { authorization: `Bearer ${pat}` },
      });
      if (mine.ok) {
        const body = (await mine.json()) as {
          towns?: Array<{ id: string; slug: string }>;
        };
        const found = body.towns?.find((t) => t.id === town.id);
        if (found) slug = found.slug;
      }
    } catch {
      // fall through to the folder-name fallback
    }
  }
  if (!slug) {
    slug = dir.split("/").pop() ?? undefined;
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
  const hasCatalog = (town.tags && town.tags.length > 0) || items.length > 0;
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
    ...(hasCatalog
      ? {
          catalog: {
            tags: town.tags ?? [],
            items,
          },
        }
      : {}),
  };

  spinner.start(
    opts.reflow ? "Uploading town (re-laying out)…" : "Uploading town…",
  );
  // Compose any active query params: ?slug=<slug> (target town), ?reflow=1
  // (rewind layout), ?from=creator (status flip for the chat-creator
  // approve flow).
  const params = new URLSearchParams();
  if (slug) params.set("slug", slug);
  if (opts.reflow) params.set("reflow", "1");
  if (opts.from) params.set("from", opts.from);
  const qs = params.toString();
  const url = qs ? `${townUrl}/api/town?${qs}` : `${townUrl}/api/town`;
  const res = await fetch(url, {
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
    .option(
      "--slug <slug>",
      "Target town slug. Defaults to the id stash in town.json (resolved via /api/towns/mine), then the folder name.",
    )
    .option(
      "--reflow",
      "Wipe the server-side plot before applying so the layout re-runs from scratch. Use when the existing town has buildings spread too wide to read as a settlement.",
    )
    .option(
      "--from <from>",
      "Internal — set to `creator` to bracket the deploy in a renovating/active status flip (used by the chat creator's approve flow).",
    )
    .action(
      async (opts: {
        dir?: string;
        slug?: string;
        reflow?: boolean;
        from?: string;
      }) => {
        await runDeploy({
          dir: opts.dir,
          slug: opts.slug,
          reflow: opts.reflow,
          from: opts.from === "creator" ? "creator" : undefined,
        });
      },
    );
}
