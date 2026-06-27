// `town delete [--slug <slug>] [--force]` — permanently delete a town.
//
// Selection mirrors `town clone`:
//   • `--slug <slug>` → delete that town directly (still asks to type
//     the slug to confirm unless `--force` is set).
//   • Else GET /api/towns/mine; 0 → bail, 1 → confirm-with-typed-slug,
//     N → Ink picker → confirm-with-typed-slug.
//
// Confirmation is type-the-slug (not y/N) because this is destructive
// and we want zero risk of muscle-memory + Enter wiping a town. The
// server cascades the delete across Aura, PlotRow, Npc, Conversation,
// PlotSuggestion, and CreatorConversation (+ CreatorMessage). Sprites
// survive (they're user-scoped). The local folder is NOT touched —
// users sometimes want to keep the .mdx files around.

import { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import React, { useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";

import { getConfig } from "../config.js";
import { getJson } from "../shared/scaffold.js";

interface TownEntry {
  id: string;
  slug: string;
  name: string;
}

interface TownsMineResponse {
  towns: TownEntry[];
}

// -----------------------------------------------------------------------------
// Ink picker — used when the caller has more than one town and didn't pin a
// slug. Same shape as the clone picker but renders in a destructive red.
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
      <Text color="red">Pick a town to delete (this cannot be undone):</Text>
      {towns.map((t, i) => (
        <Box key={t.id}>
          <Text color={i === idx ? "red" : undefined}>
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
// Type-the-slug confirmation. The user must type the slug exactly,
// which is enough friction to keep accidental deletions out of the
// happy path even on shared terminals.
// -----------------------------------------------------------------------------

interface ConfirmProps {
  town: TownEntry;
  onConfirm: () => void;
  onCancel: () => void;
}

function TypeSlugConfirm({
  town,
  onConfirm,
  onCancel,
}: ConfirmProps): React.ReactElement {
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
      if (buf.trim() === town.slug) {
        onConfirm();
      } else {
        onCancel();
      }
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
      <Text color="red">
        About to permanently delete {town.name} ({town.slug}).
      </Text>
      <Text dimColor>
        This removes all buildings, NPCs, and chat history. Type the slug to
        confirm:
      </Text>
      <Box>
        <Text color="red">{"> "}</Text>
        <Text>{buf}</Text>
        <Text color="red">▎</Text>
      </Box>
      <Text dimColor>[Enter] confirm · [Esc] cancel</Text>
    </Box>
  );
}

async function confirmWithTypedSlug(town: TownEntry): Promise<boolean> {
  return new Promise((resolveConfirm) => {
    const app = render(
      <TypeSlugConfirm
        town={town}
        onConfirm={() => {
          app.unmount();
          resolveConfirm(true);
        }}
        onCancel={() => {
          app.unmount();
          resolveConfirm(false);
        }}
      />,
    );
  });
}

// -----------------------------------------------------------------------------
// Command body
// -----------------------------------------------------------------------------

async function runDelete(opts: { slug?: string; force?: boolean }): Promise<void> {
  p.intro(chalk.bgRed(chalk.white(" town delete ")));

  const cfg = getConfig();
  if (!cfg.auth?.pat || !cfg.auth.townUrl) {
    p.cancel("Not logged in — run `town login` first.");
    process.exit(1);
  }
  const { townUrl, pat } = cfg.auth;

  let target: TownEntry | null = null;

  if (opts.slug) {
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
      p.cancel("You don't have any towns to delete.");
      return;
    }
    if (mine.towns.length === 1) {
      target = mine.towns[0]!;
    } else {
      target = await pickWithInk(mine.towns);
      if (!target) {
        p.cancel("delete cancelled");
        return;
      }
    }
  }

  if (!opts.force) {
    const ok = await confirmWithTypedSlug(target);
    if (!ok) {
      p.cancel("delete cancelled — slug did not match.");
      return;
    }
  }

  const spinner = p.spinner();
  spinner.start("Deleting town…");
  const res = await fetch(
    `${townUrl}/api/town?slug=${encodeURIComponent(target.slug)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${pat}` },
    },
  );
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // ignore — fall back to status text
    }
    spinner.stop(chalk.red(`Delete failed: ${res.status} ${detail}`));
    process.exit(1);
  }
  spinner.stop(chalk.green(`Town ${target.name} deleted.`));
  // Intentional: do NOT touch ./<slug>/ on disk. Users sometimes want
  // to keep the local files for reference or for a future `town new`
  // under a different slug.
}

export function registerDelete(program: Command): void {
  program
    .command("delete")
    .description("Permanently delete one of your towns.")
    .option("--slug <slug>", "Delete the named town directly.")
    .option("--force", "Skip the type-the-slug confirmation prompt.")
    .action(async (opts: { slug?: string; force?: boolean }) => {
      await runDelete(opts);
    });
}
