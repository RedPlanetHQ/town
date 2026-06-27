// `town new [name]` — create a fresh town and drop into the chat surface.
//
// Flow:
//   1. Name from the positional arg, OR via the Ink <NamePrompt>.
//   2. POST /api/towns/me { name } → server creates the town row.
//   3. Scaffold ./<slug>/ with the day-zero trio + default NPCs.
//   4. chdir into ./<slug>/ so subsequent commands feel like they were
//      run from the new folder.
//   5. Render <ChatApp> with a kickoff line introducing the scaffolded
//      buildings — the user types what they want next and watches the
//      model stage changes.

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
import { runDeploy } from "./deploy.js";

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
}

export async function launchChat(opts: LaunchChatOpts): Promise<void> {
  return new Promise((resolveChat) => {
    const app = render(
      <ChatApp
        townUrl={opts.townUrl}
        pat={opts.pat}
        townSlug={opts.townSlug}
        cwd={opts.cwd}
        kickoff={opts.kickoff}
        onApply={async (changes) => {
          // Apply staged changes to the local folder, then redeploy
          // with ?from=creator so the server flips renovating/active.
          await applyChangesLocally(opts.cwd, changes as CreatorChange[]);
          await runDeploy({ dir: opts.cwd, from: "creator" });
          // Drop the server-side queue so the next turn doesn't re-stage
          // the same diffs.
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
          // Re-fetch aura for the status bar — both POST /api/town and
          // the apply hit aura via tools, so we want to surface the
          // freshest value.
          try {
            const res = await fetch(`${opts.townUrl}/api/towns/mine`, {
              headers: { authorization: `Bearer ${opts.pat}` },
            });
            if (res.ok) {
              const body = (await res.json()) as {
                towns?: Array<{
                  slug: string;
                  aura?: { current: number; max: number };
                }>;
              };
              const me = body.towns?.find((t) => t.slug === opts.townSlug);
              if (me?.aura) return { aura: me.aura };
            }
          } catch {
            // tolerated — the next turn will refresh anyway.
          }
          return;
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

  // chdir so the chat surface's `cwd` line reads relative to the new
  // folder, and so a subsequent `town deploy` (without --slug) works.
  process.chdir(targetDir);

  await launchChat({
    townUrl,
    pat,
    townSlug: created.town.slug,
    townId: created.town.id,
    cwd: targetDir,
    kickoff: `I've scaffolded ${created.town.name} with home, library, store. Tell me what kind of town you're building.`,
  });
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
