// town — companion CLI for editing your plot offline and pushing it back.
//
// Commands:
//   town            Inside a folder with town.json → launch the chat creator.
//                   Outside → prints help.
//   town new        Create a new town and drop into the chat creator.
//   town clone      Pull an existing town's state into a local folder.
//   town delete     Permanently delete one of your towns.
//   town catalog    Print the global plotKey catalog.
//   town deploy     Push the local town folder to the server.
//   town login      Authenticate with CORE (saves a PAT to ~/.town/config.json).
//   town init       Hint alias — points users at `town new` / `town clone`.
//   town generate   Generate a pixel-art PNG (exterior|interior) for a custom plot.

import { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { registerLogin } from "./commands/login.js";
import { registerInit } from "./commands/init.js";
import { registerDeploy } from "./commands/deploy.js";
import { registerNew, launchChat } from "./commands/new.js";
import { registerClone } from "./commands/clone.js";
import { registerDelete } from "./commands/delete.js";
import { registerCatalog } from "./commands/catalog.js";
import { registerGenerate } from "./commands/generate.js";

import { getConfig } from "./config.js";
import { readTownJson } from "./shared/town-io.js";

const program = new Command();

program
  .name("town")
  .description("Edit your town plot from the command line.")
  .version("0.2.0");

registerLogin(program);
registerInit(program);
registerDeploy(program);
registerNew(program);
registerClone(program);
registerDelete(program);
registerCatalog(program);
registerGenerate(program);

// Bare `town`: if we're inside a town folder, drop into the chat
// surface. Otherwise fall through to Commander's default help.
program.action(async () => {
  const cwd = resolve(process.cwd());
  const townJsonPath = `${cwd}/town.json`;
  if (!existsSync(townJsonPath)) {
    program.help();
    return;
  }
  const cfg = getConfig();
  if (!cfg.auth?.pat || !cfg.auth.townUrl) {
    console.error("Not logged in — run `town login` first.");
    process.exit(1);
  }
  const { townUrl, pat } = cfg.auth;
  let townJson;
  try {
    townJson = await readTownJson(cwd);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  // Resolve the slug + name: prefer the server-issued id stash via
  // /api/towns/mine when it's present, otherwise fall back to the
  // folder name. The fallback lets pre-id-stash folders still work.
  // Name is best-effort — it feeds the Town Creator's greeting in
  // chat; an empty value just produces a generic line.
  let slug: string | undefined;
  let name: string | undefined;
  if (townJson.id) {
    try {
      const res = await fetch(`${townUrl}/api/towns/mine`, {
        headers: { authorization: `Bearer ${pat}` },
      });
      if (res.ok) {
        const body = (await res.json()) as {
          towns?: Array<{ id: string; slug: string; name: string }>;
        };
        const me = body.towns?.find((t) => t.id === townJson.id);
        if (me) {
          slug = me.slug;
          name = me.name;
        }
      }
    } catch {
      // ignored — folder name fallback below.
    }
  }
  if (!slug) {
    slug = cwd.split("/").pop() ?? "town";
  }

  await launchChat({
    townUrl,
    pat,
    townSlug: slug,
    townId: townJson.id ?? "",
    cwd,
    townName: name,
  });
});

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
