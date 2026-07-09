// `town generate exterior|interior "<concept>"` — one-shot pixel-art
// image generation for a custom plot.
//
// Talks to POST /api/creator/images on the town server, which owns the
// prompt + OpenAI call + sharp fitting. This CLI is a thin client:
//   • bearer PAT from ~/.town/config.json
//   • body: { kind, concept, category, slug?, exteriorTiles? }
//   • writes the returned PNG to --out
//   • prints aura consumed + remaining
//
// Two flags matter for the "adjust the image" loop that the plugin's
// generate-plot skill orchestrates:
//   --out <path>     Where to write the PNG. Defaults to
//                    ./<kind>.png in the current directory so a bare
//                    call inside a town folder Just Works.
//   --tiles WxH      Exterior-only bounding box in tiles (8-20 each).
//                    Ignored for interior — that footprint is locked
//                    to 18×16 by the catalog.
// Optional:
//   --category <c>   Catalog category. Defaults to WORK.
//   --slug <slug>    Target town slug. Omitted → single-town owners
//                    resolve automatically; multi-town owners must pass.

import { Command } from "commander";
import chalk from "chalk";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { getConfig } from "../config.js";

const CATEGORIES = [
  "HOME",
  "WORK",
  "READ",
  "MARKET",
  "MOVE",
  "CREATE",
  "WORKSHOP",
] as const;
type Category = (typeof CATEGORIES)[number];

interface GenerateResponse {
  kind: "exterior" | "interior";
  widthTiles: number;
  heightTiles: number;
  contentHash: string;
  byteSize: number;
  pngBase64: string;
  auraConsumed: number;
  auraRemaining: number;
}

interface AuraEmptyResponse {
  error: "aura-empty";
  auraRemaining: number;
  auraCost: number;
}

interface ErrorResponse {
  error: string;
  detail?: string;
  field?: string;
}

function parseTiles(raw: string | undefined): { w: number; h: number } | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!m) return null;
  const w = Number.parseInt(m[1]!, 10);
  const h = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w, h };
}

async function runGenerate(args: {
  kind: "exterior" | "interior";
  concept: string;
  category: string;
  out: string;
  slug?: string;
  tiles?: string;
}): Promise<void> {
  const cfg = getConfig();
  if (!cfg.auth?.pat || !cfg.auth.townUrl) {
    console.error(chalk.red("Not logged in — run `town login` first."));
    process.exit(1);
  }
  const { townUrl, pat } = cfg.auth;

  const concept = args.concept.trim();
  if (concept.length < 4) {
    console.error(chalk.red("Concept must be at least 4 characters."));
    process.exit(1);
  }
  if (concept.length > 400) {
    console.error(chalk.red("Concept must be at most 400 characters."));
    process.exit(1);
  }

  const category = (args.category ?? "WORK").toUpperCase() as Category;
  if (!CATEGORIES.includes(category)) {
    console.error(
      chalk.red(
        `Invalid --category "${args.category}". One of: ${CATEGORIES.join(", ")}`,
      ),
    );
    process.exit(1);
  }

  let exteriorTiles: { w: number; h: number } | undefined;
  if (args.kind === "exterior" && args.tiles) {
    const parsed = parseTiles(args.tiles);
    if (!parsed) {
      console.error(chalk.red(`--tiles must be like 12x12 (got "${args.tiles}").`));
      process.exit(1);
    }
    exteriorTiles = parsed;
  }

  const outPath = resolve(process.cwd(), args.out);

  console.log(
    chalk.dim(
      `→ generating ${args.kind}${exteriorTiles ? ` @ ${exteriorTiles.w}×${exteriorTiles.h}` : ""} · category ${category}`,
    ),
  );
  console.log(chalk.dim(`  concept: ${concept}`));

  const body = {
    kind: args.kind,
    concept,
    category,
    ...(args.slug ? { slug: args.slug } : {}),
    ...(exteriorTiles ? { exteriorTiles } : {}),
  };

  const started = Date.now();
  const res = await fetch(`${townUrl}/api/creator/images`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify(body),
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (res.status === 402) {
    const err = (await res.json().catch(() => null)) as AuraEmptyResponse | null;
    console.error(
      chalk.red(
        `Aura empty — this town has ${err?.auraRemaining ?? 0} aura, needs ${err?.auraCost ?? 25}. Top up before retrying.`,
      ),
    );
    process.exit(1);
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ErrorResponse | null;
    const label = err?.error ?? `http ${res.status}`;
    const detail = err?.detail ?? err?.field ?? "";
    console.error(chalk.red(`Image generation failed: ${label}${detail ? ` (${detail})` : ""}`));
    process.exit(1);
  }

  const data = (await res.json()) as GenerateResponse;
  const bytes = Buffer.from(data.pngBase64, "base64");
  await writeFile(outPath, bytes);

  const kb = (data.byteSize / 1024).toFixed(1);
  console.log("");
  console.log(chalk.green("✓ ") + chalk.bold(outPath));
  console.log(
    chalk.dim(
      `  ${data.widthTiles}×${data.heightTiles} tiles · ${kb} KB · sha ${data.contentHash.slice(0, 8)} · ${elapsed}s`,
    ),
  );
  console.log(
    chalk.dim(
      `  aura: ${chalk.yellow(`-${data.auraConsumed}`)}  remaining: ${chalk.cyan(data.auraRemaining)}`,
    ),
  );
}

export function registerGenerate(program: Command): void {
  const generate = program
    .command("generate")
    .description("Generate a pixel-art PNG for a custom plot (exterior or interior).");

  generate
    .command("exterior <concept>")
    .description(
      "Generate the outside of a building. Fits into a --tiles box (default 12x12). Concept is a 1-3 sentence description.",
    )
    .option("--out <path>", "Where to write the PNG.", "exterior.png")
    .option("--tiles <WxH>", "Bounding box in tiles, e.g. 12x12 (each side 8-20).")
    .option(
      "--category <cat>",
      `Catalog category (${CATEGORIES.join("|")}).`,
      "WORK",
    )
    .option("--slug <slug>", "Target town slug (defaults to your only town).")
    .action(
      async (
        concept: string,
        opts: { out: string; tiles?: string; category: string; slug?: string },
      ) => {
        await runGenerate({
          kind: "exterior",
          concept,
          out: opts.out,
          tiles: opts.tiles,
          category: opts.category,
          slug: opts.slug,
        });
      },
    );

  generate
    .command("interior <concept>")
    .description(
      "Generate the top-down interior of a building. Locked to the catalog's 18×16 tile box.",
    )
    .option("--out <path>", "Where to write the PNG.", "interior.png")
    .option(
      "--category <cat>",
      `Catalog category (${CATEGORIES.join("|")}).`,
      "WORK",
    )
    .option("--slug <slug>", "Target town slug (defaults to your only town).")
    .action(
      async (
        concept: string,
        opts: { out: string; category: string; slug?: string },
      ) => {
        await runGenerate({
          kind: "interior",
          concept,
          out: opts.out,
          category: opts.category,
          slug: opts.slug,
        });
      },
    );
}
