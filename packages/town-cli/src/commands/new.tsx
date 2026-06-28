// `town new [name]` — create a fresh town folder.
//
// Flow:
//   1. Name from the positional arg, OR via the Ink <NamePrompt>.
//   2. POST /api/towns/me { name } → server creates the town row.
//   3. Scaffold ./<slug>/ with the day-zero trio + default NPCs.
//   4. Exit with a hint: `cd <slug> && town` to enter the chat creator.
//
// We intentionally do NOT auto-launch chat here. Splitting scaffold
// from chat lets the user inspect the folder, commit to git, or open
// in their editor before starting the creator loop.

import { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import React, { useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import { resolve } from "node:path";

import { getConfig } from "../config.js";
import {
  ensureSlugDir,
  postJson,
  scaffoldNew,
} from "../shared/scaffold.js";
import { ChatApp } from "../tui/chat-app.js";
import {
  applyChangesLocally,
  type CreatorChange,
} from "../tui/apply-changes.js";
import { runDeployQuiet } from "./deploy.js";

interface TownsMeCreate {
  town: { id: string; slug: string; name: string };
}

// -----------------------------------------------------------------------------
// Ink prompt — used when no positional name is supplied. Returns the
// text the user typed, or null if they hit Esc.
// -----------------------------------------------------------------------------

interface NamePromptProps {
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

function NamePrompt({ onSubmit, onCancel }: NamePromptProps): React.ReactElement {
  const { exit } = useApp();
  const [buf, setBuf] = useState("");

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (!buf.trim()) return;
      onSubmit(buf.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setBuf((s) => s.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setBuf((s) => s + input);
    }
  });

  return (
    <Box flexDirection="column">
      <Text>What's the town name?</Text>
      <Box>
        <Text color="cyan">{"> "}</Text>
        <Text>{buf}</Text>
        <Text color="cyan">▎</Text>
      </Box>
      <Text dimColor>[Enter] create · [Esc] cancel</Text>
    </Box>
  );
}

async function promptForName(): Promise<string | null> {
  return new Promise((resolveName) => {
    const app = render(
      <NamePrompt
        onSubmit={(name) => {
          app.unmount();
          resolveName(name);
        }}
        onCancel={() => {
          app.unmount();
          resolveName(null);
        }}
      />,
    );
  });
}

// -----------------------------------------------------------------------------
// Chat launch — split out so `bare town` in step 6 can reuse it without
// going through the scaffold path.
// -----------------------------------------------------------------------------

export interface LaunchChatOpts {
  townUrl: string;
  pat: string;
  townSlug: string;
  townId: string;
  cwd: string;
  kickoff?: string;
  /** Display name interpolated into the Town Creator's default
   *  greeting. Optional — falls back to a generic "this town" line. */
  townName?: string;
}

export async function launchChat(opts: LaunchChatOpts): Promise<void> {
  return new Promise((resolveChat) => {
    // Switch to the alt screen buffer + clear + home cursor.
    //
    // Why alt screen (and not just clear): Ink positions its dynamic
    // frame relative to where its first render ended. In the main
    // buffer, when our frame plus the growing chat history exceeds the
    // terminal viewport, Ink's cursor-up math goes wrong and every
    // re-render APPENDS instead of REPLACING (you'd see a stack of
    // duplicate dividers as you type). Alt screen gives Ink a known
    // virtual canvas where its cursor tracking stays honest.
    //
    // The trade-off is that the terminal's native scrollback isn't
    // preserved — we'll surface long histories via in-chat pagination
    // rather than terminal scroll.
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
    const app = render(
      <ChatApp
        townUrl={opts.townUrl}
        pat={opts.pat}
        townSlug={opts.townSlug}
        cwd={opts.cwd}
        kickoff={opts.kickoff}
        townName={opts.townName}
        onApply={async (changes, hooks) => {
          // 1. Apply staged changes to the local folder (fast — fs +
          //    sprite fetch). We await this so the chat surface knows
          //    when the diff has visibly cleared.
          await applyChangesLocally(
            opts.cwd,
            changes as CreatorChange[],
            opts.townUrl,
          );
          // 2. Kick off the redeploy in the background. We do NOT
          //    await it — the chat surface stays usable, and we drive
          //    its inline status via the phase callbacks. runDeployQuiet
          //    never writes to stdout (no clack-prompts), so it can't
          //    corrupt the Ink frame the way runDeploy used to.
          hooks.onDeployPhase("deploying");
          void (async () => {
            try {
              await runDeployQuiet({
                dir: opts.cwd,
                from: "creator",
              });
              // 2a. Drop the server-side queue so the next turn doesn't
              //     re-stage the same diffs.
              await fetch(`${opts.townUrl}/api/creator`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${opts.pat}`,
                },
                body: JSON.stringify({
                  townSlug: opts.townSlug,
                  action: "clear-changes",
                }),
              });
              // 2b. Refresh aura — both POST /api/town and the apply
              //     hit aura via tools, so we want the freshest value.
              let aura: { current: number; max: number } | undefined;
              try {
                const res = await fetch(
                  `${opts.townUrl}/api/towns/mine`,
                  { headers: { authorization: `Bearer ${opts.pat}` } },
                );
                if (res.ok) {
                  const body = (await res.json()) as {
                    towns?: Array<{
                      slug: string;
                      aura?: { current: number; max: number };
                    }>;
                  };
                  const me = body.towns?.find(
                    (t) => t.slug === opts.townSlug,
                  );
                  if (me?.aura) aura = me.aura;
                }
              } catch {
                // tolerated — next turn will refresh anyway.
              }
              hooks.onDeployPhase("deployed", aura ? { aura } : undefined);
            } catch (err) {
              hooks.onDeployPhase("failed", {
                message:
                  err instanceof Error ? err.message : "unknown error",
              });
            }
          })();
        }}
      />,
    );
    app.waitUntilExit().then(() => resolveChat());
  });
}

// -----------------------------------------------------------------------------
// Command entry
// -----------------------------------------------------------------------------

async function runNew(positionalName: string | undefined): Promise<void> {
  const cfg = getConfig();
  if (!cfg.auth?.pat || !cfg.auth.townUrl) {
    p.cancel("Not logged in — run `town login` first.");
    process.exit(1);
  }
  const { townUrl, pat, coreUrl } = cfg.auth;

  let name: string | null = positionalName?.trim() ?? null;
  if (!name) {
    name = await promptForName();
  }
  if (!name) {
    p.cancel("Cancelled");
    return;
  }

  // Create the town on the server.
  const spinner = p.spinner();
  spinner.start("Creating town on the server…");
  let created: TownsMeCreate;
  try {
    created = await postJson<TownsMeCreate>(
      `${townUrl}/api/towns/me`,
      pat,
      { name },
    );
  } catch (err) {
    spinner.stop(chalk.red("Town creation failed"));
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  spinner.stop(
    chalk.green(`Created ${created.town.name} (/${created.town.slug})`),
  );

  // Scaffold the local folder.
  const targetDir = resolve(process.cwd(), created.town.slug);
  await ensureSlugDir(targetDir, created.town.slug);
  await scaffoldNew(pat, targetDir, coreUrl, created.town.id);
  p.log.success(`Scaffolded ./${created.town.slug}/`);

  // Hand off to the chat surface explicitly — keeps `town new` as a
  // pure scaffold step the user can pause on (inspect files, commit
  // to git) before entering the creator loop.
  console.log("");
  console.log(
    `  ${chalk.cyan("cd")} ${chalk.bold(created.town.slug)} ${chalk.dim("&&")} ${chalk.cyan("town")}`,
  );
  console.log(chalk.dim("  ↑ run that to open the chat creator."));
  console.log("");
}

export function registerNew(program: Command): void {
  program
    .command("new [name]")
    .description(
      "Create a new town (prompts for the name when omitted) and launch the chat creator inside it.",
    )
    .action(async (name?: string) => {
      await runNew(name);
    });
}
