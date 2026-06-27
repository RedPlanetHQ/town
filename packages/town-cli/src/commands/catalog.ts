// `town catalog [--slug <slug>]` — print the catalog the chat creator
// can author against.
//
// Without `--slug`: hit /api/catalog and list every plotKey grouped by
// category. With `--slug`: additionally pull /api/town?slug=… to print
// the per-town visitor tags + item templates.

import { Command } from "commander";
import chalk from "chalk";

import { getConfig } from "../config.js";
import { getJson } from "../shared/scaffold.js";

interface CatalogPlotKey {
  key: string;
  category: string;
}

interface CatalogResponse {
  plotKeys: CatalogPlotKey[];
}

interface TownTagDef {
  id: string;
  label: string;
  emoji: string;
}

interface TownItemDef {
  id: string;
  label: string;
  description: string;
}

interface TownResponse {
  catalog?: {
    tags: TownTagDef[];
    items: TownItemDef[];
  };
}

async function runCatalog(opts: { slug?: string }): Promise<void> {
  const cfg = getConfig();
  if (!cfg.auth?.pat || !cfg.auth.townUrl) {
    console.error("Not logged in — run `town login` first.");
    process.exit(1);
  }
  const { townUrl, pat } = cfg.auth;

  const global = await getJson<CatalogResponse>(`${townUrl}/api/catalog`, pat);
  const grouped = new Map<string, string[]>();
  for (const pk of global.plotKeys) {
    const list = grouped.get(pk.category) ?? [];
    list.push(pk.key);
    grouped.set(pk.category, list);
  }
  console.log(chalk.bold("Global catalog (plotKeys by category):"));
  for (const [cat, keys] of [...grouped.entries()].sort()) {
    console.log(`  ${chalk.cyan(cat)}: ${keys.sort().join(", ")}`);
  }

  if (!opts.slug) return;

  const town = await getJson<TownResponse>(
    `${townUrl}/api/town?slug=${encodeURIComponent(opts.slug)}`,
    pat,
  );
  console.log("");
  console.log(chalk.bold(`Town /${opts.slug} catalog:`));
  if (!town.catalog || (town.catalog.tags.length === 0 && town.catalog.items.length === 0)) {
    console.log(chalk.dim("  (no per-town tags or item templates yet)"));
    return;
  }
  if (town.catalog.tags.length > 0) {
    console.log(chalk.bold("  Tags:"));
    for (const t of town.catalog.tags) {
      console.log(`    ${t.emoji} ${chalk.cyan(t.id)} — ${t.label}`);
    }
  }
  if (town.catalog.items.length > 0) {
    console.log(chalk.bold("  Item templates:"));
    for (const it of town.catalog.items) {
      console.log(`    ${chalk.cyan(it.id)} — ${it.label}`);
      if (it.description) console.log(`      ${chalk.dim(it.description)}`);
    }
  }
}

export function registerCatalog(program: Command): void {
  program
    .command("catalog")
    .description(
      "Print the catalog (global plotKeys; with --slug, the per-town tags + item templates too).",
    )
    .option("--slug <slug>", "Town slug whose per-town catalog to include.")
    .action(async (opts: { slug?: string }) => {
      await runCatalog(opts);
    });
}
