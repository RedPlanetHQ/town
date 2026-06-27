// `town init` — kept around as a migration hint.
//
// Prior versions of the CLI shipped a single `init` verb that did both
// create + clone. We've since split that into `town new` (greenfield)
// and `town clone` (pull an existing town). Users on the old muscle
// memory still get a clear pointer instead of a 404.

import { Command } from "commander";
import chalk from "chalk";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description(
      "Hint alias — points you at `town new` (create) or `town clone` (pull existing).",
    )
    .action(() => {
      console.error(
        chalk.yellow(
          "`town init` has been replaced. Use `town new` to create a town or `town clone` to pull an existing one.",
        ),
      );
      process.exit(1);
    });
}
