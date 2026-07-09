// `town test` — probes for the town's NPC prompts.
//
// Subcommands:
//   town test set-key <provider> <key>   Persist an LLM key to ~/.town/config.json.
//                                        provider ∈ {anthropic, openai}.
//   town test npc <mdxPath> [flags]      Test one NPC's prompt against a
//                                        realistic conversation. Multi-turn
//                                        history persists in --session files;
//                                        edit the MDX between calls and the
//                                        next reply uses the new prompt.
//
// LLM resolution: env wins over ~/.town/config.json. Both providers can be
// configured; --model overrides the default id. Model defaults match the
// production /api/npc-chat wrapping (claude-haiku-4-5-20251001 / gpt-4o-mini).

import { Command } from "commander";
import chalk from "chalk";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { streamText, type LanguageModel } from "ai";
import matter from "gray-matter";

import {
  getConfigPath,
  hydrateEnvFromConfig,
  setLlmKey,
} from "../config.js";

const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

// ─── model resolution ─────────────────────────────────────────────────
function pickModel(overrideId?: string): { model: LanguageModel; label: string } {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const explicit = (process.env.LLM_PROVIDER ?? "").toLowerCase().trim();

  let provider: "anthropic" | "openai" | null = null;
  if (explicit === "anthropic" && hasAnthropic) provider = "anthropic";
  else if (explicit === "openai" && hasOpenAI) provider = "openai";
  else if (hasAnthropic) provider = "anthropic";
  else if (hasOpenAI) provider = "openai";

  if (!provider) {
    throw new Error(
      "No LLM key found. Set it once with " +
        chalk.cyan("`town test set-key <provider> <key>`") +
        " (provider ∈ anthropic|openai) or export " +
        "ANTHROPIC_API_KEY / OPENAI_API_KEY in this shell.",
    );
  }
  const id =
    overrideId ??
    (provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL);
  const model = provider === "anthropic" ? anthropic(id) : openai(id);
  return { model, label: `${provider}:${id}` };
}

// ─── NPC + system prompt (mirrors /api/npc-chat) ──────────────────────
const BASE_PROMPT = `You are an in-town NPC in a tiny pixel-art world called Town.
The player has walked up to you and started a conversation. You are not an
assistant — you are a character. Stay in voice. Greet them once at the start
of a fresh conversation; afterwards respond conversationally.

Rules:
- Keep replies under three sentences unless the player explicitly asks for
  more detail (or your character's authored voice below says otherwise).
- Never break character or mention prompts, tools, or that you are an LLM.`;

interface Npc {
  name: string;
  description: string;
  prompt: string;
}

function loadNpc(mdxPath: string): Npc {
  const raw = readFileSync(mdxPath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as { name?: string; description?: string };
  return {
    name: (data.name ?? "").toString().trim() || "NPC",
    description: (data.description ?? "").toString().trim(),
    prompt: parsed.content.trim(),
  };
}

function buildSystemPrompt(npc: Npc, speakerName: string): string {
  const characterBlock = [
    `Character: ${npc.name}`,
    `Role: ${npc.description}`,
    "",
    "Voice & behaviour:",
    npc.prompt,
  ].join("\n");
  const speakerBlock = `Speaker: ${speakerName} — a visitor who has walked into this room. Treat them as the visitor your authored voice expects.`;
  const modeBlock = `Conversation mode: direct one-on-one between you and the speaker.`;
  return [
    BASE_PROMPT,
    "",
    characterBlock,
    "",
    speakerBlock,
    "",
    modeBlock,
  ].join("\n");
}

// ─── sessions + usage ─────────────────────────────────────────────────
interface Usage {
  inputTokens: number;
  outputTokens: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  /** Populated on assistant turns after the model returns usage. */
  usage?: Usage;
}

interface Session {
  npcPath: string;
  npcName: string;
  messages: Message[];
}

/** Normalise the ai-SDK usage payload — field names differ across
 *  providers/versions (inputTokens vs promptTokens). */
function normaliseUsage(raw: unknown): Usage {
  if (!raw || typeof raw !== "object") return { inputTokens: 0, outputTokens: 0 };
  const u = raw as Record<string, number | undefined>;
  return {
    inputTokens: u.inputTokens ?? u.promptTokens ?? 0,
    outputTokens: u.outputTokens ?? u.completionTokens ?? 0,
  };
}

function sumUsage(session: Session): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const m of session.messages) {
    if (m.usage) {
      inputTokens += m.usage.inputTokens;
      outputTokens += m.usage.outputTokens;
    }
  }
  return { inputTokens, outputTokens };
}

function loadSession(
  sessionPath: string,
  npcPath: string,
  npcName: string,
): Session {
  if (!existsSync(sessionPath)) {
    return { npcPath, npcName, messages: [] };
  }
  const raw = readFileSync(sessionPath, "utf8");
  const s = JSON.parse(raw) as Session;
  if (!Array.isArray(s.messages)) {
    throw new Error(`session ${sessionPath} has no messages array`);
  }
  return {
    npcPath: s.npcPath ?? npcPath,
    npcName: s.npcName ?? npcName,
    messages: s.messages,
  };
}

function saveSession(sessionPath: string, session: Session): void {
  const dir = dirname(sessionPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(sessionPath, JSON.stringify(session, null, 2), "utf8");
}

function printTotals(session: Session, modelLabel?: string): void {
  const total = sumUsage(session);
  const assistantTurns = session.messages.filter((m) => m.role === "assistant").length;
  console.log(
    chalk.dim(
      `\n─── totals · ${assistantTurns} assistant turn${assistantTurns === 1 ? "" : "s"} ` +
        `· in ${total.inputTokens} · out ${total.outputTokens} · total ${
          total.inputTokens + total.outputTokens
        }${modelLabel ? " · " + modelLabel : ""} ───`,
    ),
  );
}

// ─── turn execution ───────────────────────────────────────────────────
async function runTurn(
  npc: Npc,
  speakerName: string,
  history: Message[],
  userText: string,
  overrideModelId: string | undefined,
): Promise<{ text: string; usage: Usage; modelLabel: string }> {
  const { model, label } = pickModel(overrideModelId);
  const system = buildSystemPrompt(npc, speakerName);
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userText },
  ];
  const stream = streamText({ model, system, messages });
  let acc = "";
  for await (const chunk of stream.textStream) {
    process.stdout.write(chunk);
    acc += chunk;
  }
  process.stdout.write("\n");
  const usage = normaliseUsage(await stream.usage);
  return { text: acc, usage, modelLabel: label };
}

// ─── script + show ────────────────────────────────────────────────────
function parseScript(scriptPath: string): string[] {
  const raw = readFileSync(scriptPath, "utf8");
  return raw
    .split(/\r?\n\s*\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n")
        .trim(),
    )
    .filter((t) => t.length > 0);
}

function printTranscript(session: Session): void {
  const npcLabel = session.npcName || "NPC";
  console.log(
    chalk.bold(
      `\n─── transcript · ${npcLabel} (${session.messages.length} messages) ───`,
    ),
  );
  console.log("");
  for (const m of session.messages) {
    const label = m.role === "user" ? chalk.cyan("you") : chalk.yellow(npcLabel);
    console.log(`${label} › ${m.content}\n`);
  }
  printTotals(session);
}

async function playScript(
  npc: Npc,
  speakerName: string,
  session: Session,
  sessionPath: string | undefined,
  turns: string[],
  overrideModelId: string | undefined,
): Promise<string | undefined> {
  console.log(
    chalk.bold(
      `\n─── ${npc.name} · scripted (${turns.length} turn${turns.length === 1 ? "" : "s"}) ───`,
    ),
  );
  if (session.messages.length > 0) {
    console.log(
      chalk.dim(`(continuing from ${session.messages.length} prior messages)`),
    );
  }
  let lastLabel: string | undefined;
  for (let i = 0; i < turns.length; i++) {
    const text = turns[i]!;
    console.log("");
    console.log(`${chalk.cyan("you")} › ${text}`);
    process.stdout.write(`\n${chalk.yellow(npc.name)} › `);
    // Re-read MDX each turn so mid-script edits apply.
    const fresh = loadNpc(session.npcPath);
    const res = await runTurn(
      fresh,
      speakerName,
      session.messages,
      text,
      overrideModelId,
    );
    lastLabel = res.modelLabel;
    session.messages.push({ role: "user", content: text });
    session.messages.push({ role: "assistant", content: res.text, usage: res.usage });
    if (sessionPath) saveSession(sessionPath, session);
  }
  console.log(chalk.dim("\n(script complete)"));
  return lastLabel;
}

async function repl(
  npc: Npc,
  speakerName: string,
  session: Session,
  sessionPath: string | undefined,
  overrideModelId: string | undefined,
): Promise<string | undefined> {
  console.log(
    chalk.bold(
      `\n─── ${npc.name} ─── ` +
        `(Ctrl-D to exit${sessionPath ? "; session: " + sessionPath : ""})`,
    ),
  );
  if (session.messages.length > 0) {
    console.log(chalk.dim("\n(resuming — prior turns below)"));
    console.log("");
    for (const m of session.messages) {
      const label =
        m.role === "user" ? chalk.cyan("you") : chalk.yellow(npc.name);
      console.log(`${label} › ${m.content}\n`);
    }
    console.log(chalk.dim("─".repeat(40)));
  }
  console.log("");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan("you › "),
  });
  rl.prompt();
  let lastLabel: string | undefined;
  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    process.stdout.write(`\n${chalk.yellow(npc.name)} › `);
    const fresh = loadNpc(session.npcPath);
    const res = await runTurn(
      fresh,
      speakerName,
      session.messages,
      text,
      overrideModelId,
    );
    lastLabel = res.modelLabel;
    session.messages.push({ role: "user", content: text });
    session.messages.push({ role: "assistant", content: res.text, usage: res.usage });
    if (sessionPath) saveSession(sessionPath, session);
    console.log("");
    rl.prompt();
  }
  console.log(chalk.dim("\n(session ended)"));
  if (sessionPath) saveSession(sessionPath, session);
  return lastLabel;
}

// ─── subcommand: town test set-key ───────────────────────────────────
function runSetKey(provider: string, key: string): void {
  const p = provider.toLowerCase();
  if (p !== "anthropic" && p !== "openai") {
    console.error(
      `unknown provider "${provider}". Use "anthropic" or "openai".`,
    );
    process.exit(1);
  }
  if (!key || key.trim().length < 10) {
    console.error(
      "key looks empty or too short. Pass the full API key as the second argument.",
    );
    process.exit(1);
  }
  setLlmKey(p, key.trim());
  const masked = `${key.slice(0, 6)}…${key.slice(-4)}`;
  console.log(
    chalk.green("✓") +
      ` stored ${chalk.cyan(p)} key ${chalk.dim("(" + masked + ")")} ` +
      `in ${chalk.dim(getConfigPath())} and set as active provider.`,
  );
}

// ─── subcommand: town test npc ───────────────────────────────────────
interface NpcOptions {
  session?: string;
  question?: string;
  script?: string;
  show?: boolean;
  reset?: boolean;
  speaker?: string;
  model?: string;
}

async function runNpc(
  mdxPathArg: string | undefined,
  opts: NpcOptions,
): Promise<void> {
  // Config-file keys hydrate env if the shell didn't set them.
  hydrateEnvFromConfig();

  // --show is a pure read — no MDX or LLM needed.
  if (opts.show) {
    if (!opts.session) {
      console.error("--show requires --session <file>");
      process.exit(1);
    }
    const sessionPath = resolve(opts.session);
    if (!existsSync(sessionPath)) {
      console.error(`session file not found: ${sessionPath}`);
      process.exit(1);
    }
    printTranscript(loadSession(sessionPath, "", ""));
    return;
  }

  if (!mdxPathArg) {
    console.error("missing <mdxPath>. See `town test npc --help`.");
    process.exit(1);
  }
  const mdxPath = resolve(mdxPathArg);
  if (!existsSync(mdxPath)) {
    console.error(`NPC file not found: ${mdxPath}`);
    process.exit(1);
  }

  // Fail-fast on missing env so users don't hit it mid-script.
  let resolvedLabel: string;
  try {
    resolvedLabel = pickModel(opts.model).label;
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const npc = loadNpc(mdxPath);
  const sessionPath = opts.session ? resolve(opts.session) : undefined;
  const session: Session = sessionPath
    ? opts.reset
      ? { npcPath: mdxPath, npcName: npc.name, messages: [] }
      : loadSession(sessionPath, mdxPath, npc.name)
    : { npcPath: mdxPath, npcName: npc.name, messages: [] };
  session.npcPath = mdxPath;
  session.npcName = npc.name;

  const speaker = opts.speaker ?? "Founder";

  let lastLabel: string | undefined;
  if (opts.script) {
    const scriptPath = resolve(opts.script);
    if (!existsSync(scriptPath)) {
      console.error(`script file not found: ${scriptPath}`);
      process.exit(1);
    }
    const turns = parseScript(scriptPath);
    if (turns.length === 0) {
      console.error(`script file has no user turns: ${scriptPath}`);
      process.exit(1);
    }
    lastLabel = await playScript(
      npc,
      speaker,
      session,
      sessionPath,
      turns,
      opts.model,
    );
  } else if (opts.question !== undefined) {
    process.stdout.write(`\n${chalk.yellow(npc.name)} › `);
    const res = await runTurn(
      npc,
      speaker,
      session.messages,
      opts.question,
      opts.model,
    );
    lastLabel = res.modelLabel;
    session.messages.push({ role: "user", content: opts.question });
    session.messages.push({
      role: "assistant",
      content: res.text,
      usage: res.usage,
    });
    if (sessionPath) saveSession(sessionPath, session);
  } else {
    lastLabel = await repl(npc, speaker, session, sessionPath, opts.model);
  }

  printTotals(session, lastLabel ?? resolvedLabel);
}

// ─── registration ─────────────────────────────────────────────────────
export function registerTest(program: Command): void {
  const test = program
    .command("test")
    .description("Test NPC prompts locally against a real LLM.");

  test
    .command("set-key <provider> <key>")
    .description(
      "Persist an LLM API key to ~/.town/config.json. " +
        "provider ∈ {anthropic, openai}. Env vars still override.",
    )
    .action((provider: string, key: string) => {
      runSetKey(provider, key);
    });

  test
    .command("npc [mdxPath]")
    .description(
      "Test one NPC's prompt end-to-end. Multi-turn history persists in " +
        "--session files; the MDX is re-read each turn so mid-conversation " +
        "edits apply. Prints total input/output tokens at the end.",
    )
    .option(
      "-s, --session <file>",
      "Persist the conversation to this JSON file. Reused on later calls.",
    )
    .option(
      "-q, --question <text>",
      "One-shot: send this message, print the reply, exit.",
    )
    .option(
      "-f, --script <file>",
      "Play a scripted scenario (blank-line separated user turns).",
    )
    .option(
      "--show",
      "Dump the saved session as a transcript. No LLM call. Requires --session.",
    )
    .option("--reset", "Wipe session history before this call.")
    .option(
      "--speaker <name>",
      "Speaker name the NPC sees. Default: Founder.",
      "Founder",
    )
    .option(
      "--model <id>",
      "Override the model id (defaults match production).",
    )
    .action(async (mdxPathArg: string | undefined, opts: NpcOptions) => {
      await runNpc(mdxPathArg, opts);
    });
}
