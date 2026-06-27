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
import { resolve } from "node:path";

import { getConfig } from "../config.js";
import {
  cloneExisting,
  ensureSlugDir,
  getJson,
  postJson,
  scaffoldNew,
} from "../shared/scaffold.js";

interface TownsMeResponse {
  town: { id: string; slug: string; name: string } | null;
}

interface TownsMeCreate {
  town: { id: string; slug: string; name: string };
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
    await scaffoldNew(pat, targetDir, cfg.auth.coreUrl, town.id);
    p.log.success(`Scaffolded ./${town.slug}/ with the day-zero trio`);
    p.outro(
      chalk.green(
        `Edit ${town.slug}/town.json (+ customPlots / npcs), then run \`town deploy\` from inside ${town.slug}/.`,
      ),
    );
  } else {
    await cloneExisting(townUrl, pat, targetDir, town.slug, town.id);
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
