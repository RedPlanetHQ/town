// `town clone [--slug <slug>]` — pull an existing town into a local
// folder.
//
// Selection:
//   • `--slug <slug>` → clone directly.
//   • Else GET /api/towns/mine; if 1 town confirm and clone, if 0
//     bail with a "run `town new`" hint, if >1 render an Ink picker.

import { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import React, { useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import { resolve } from "node:path";

import { getConfig } from "../config.js";
import {
  cloneExisting,
  ensureSlugDir,
  getJson,
} from "../shared/scaffold.js";

interface TownEntry {
  id: string;
  slug: string;
  name: string;
}

interface TownsMineResponse {
  towns: TownEntry[];
}

// -----------------------------------------------------------------------------
// Ink picker
// -----------------------------------------------------------------------------

interface PickerProps {
  towns: TownEntry[];
  onPick: (town: TownEntry) => void;
  onCancel: () => void;
}

function TownPicker({ towns, onPick, onCancel }: PickerProps): React.ReactElement {
  const { exit } = useApp();
  const [idx, setIdx] = useState(0);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setIdx((i) => (i - 1 + towns.length) % towns.length);
      return;
    }
    if (key.downArrow) {
      setIdx((i) => (i + 1) % towns.length);
      return;
    }
    if (key.return) {
      onPick(towns[idx]!);
    }
  });

  return (
    <Box flexDirection="column">
      <Text>Pick a town to clone:</Text>
      {towns.map((t, i) => (
        <Box key={t.id}>
          <Text color={i === idx ? "cyan" : undefined}>
            {i === idx ? "› " : "  "}
            {t.name}{" "}
          </Text>
          <Text dimColor>(/{t.slug})</Text>
        </Box>
      ))}
      <Text dimColor>↑/↓ move · Enter pick · Esc cancel</Text>
    </Box>
  );
}

async function pickWithInk(towns: TownEntry[]): Promise<TownEntry | null> {
  return new Promise((resolvePick) => {
    const app = render(
      <TownPicker
        towns={towns}
        onPick={(t) => {
          app.unmount();
          resolvePick(t);
        }}
        onCancel={() => {
          app.unmount();
          resolvePick(null);
        }}
      />,
    );
  });
}

// -----------------------------------------------------------------------------
// Command body
// -----------------------------------------------------------------------------

async function runClone(opts: { slug?: string }): Promise<void> {
  p.intro(chalk.bgCyan(chalk.black(" town clone ")));

  const cfg = getConfig();
  if (!cfg.auth?.pat || !cfg.auth.townUrl) {
    p.cancel("Not logged in — run `town login` first.");
    process.exit(1);
  }
  const { townUrl, pat } = cfg.auth;

  let target: TownEntry | null = null;

  if (opts.slug) {
    // Confirm by hitting /api/towns/mine and matching the slug — that
    // way we surface the town id for the local town.json stash.
    const mine = await getJson<TownsMineResponse>(
      `${townUrl}/api/towns/mine`,
      pat,
    );
    const found = mine.towns.find((t) => t.slug === opts.slug);
    if (!found) {
      p.cancel(`No town with slug "${opts.slug}" in your owned list.`);
      process.exit(1);
    }
    target = found;
  } else {
    const mine = await getJson<TownsMineResponse>(
      `${townUrl}/api/towns/mine`,
      pat,
    );
    if (mine.towns.length === 0) {
      p.cancel("You don't have any towns yet — run `town new` first.");
      process.exit(1);
    }
    if (mine.towns.length === 1) {
      const only = mine.towns[0]!;
      const ok = (await p.confirm({
        message: `Clone ${only.name} (/${only.slug})?`,
        initialValue: true,
      })) as boolean;
      if (p.isCancel(ok) || !ok) {
        p.cancel("clone cancelled");
        return;
      }
      target = only;
    } else {
      target = await pickWithInk(mine.towns);
      if (!target) {
        p.cancel("clone cancelled");
        return;
      }
    }
  }

  const targetDir = resolve(process.cwd(), target.slug);
  await ensureSlugDir(targetDir, target.slug);
  await cloneExisting(townUrl, pat, targetDir, target.slug, target.id);
  p.outro(
    chalk.green(
      `Cloned ${target.name} into ./${target.slug}/. Run \`town deploy\` from inside the folder.`,
    ),
  );
}

export function registerClone(program: Command): void {
  program
    .command("clone")
    .description("Pull an existing town's state into a local folder.")
    .option("--slug <slug>", "Clone the named town directly.")
    .action(async (opts: { slug?: string }) => {
      await runClone(opts);
    });
}
