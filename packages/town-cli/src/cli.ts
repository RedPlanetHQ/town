// town — companion CLI for editing your plot offline and pushing it back.
//
// Commands:
//   town login   Authenticate with CORE (saves a PAT to ~/.town/config.json).
//   town init    Create a new town OR pull your existing one into a local
//                folder named after the slug.
//   town deploy  Push local town.json + customPlots + npcs back to the server.

import { Command } from "commander";
import { registerLogin } from "./commands/login.js";
import { registerInit } from "./commands/init.js";
import { registerDeploy } from "./commands/deploy.js";

const program = new Command();

program
  .name("town")
  .description("Edit your town plot from the command line.")
  .version("0.1.0");

registerLogin(program);
registerInit(program);
registerDeploy(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
