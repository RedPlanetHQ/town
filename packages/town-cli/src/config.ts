// Read/write ~/.town/config.json. Mirrors how CORE's CLI persists its
// PAT in ~/.corebrain/config.json — same shape, separate file so `town`
// and `corebrain` can be authenticated independently if needed.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

const CONFIG_DIR = join(homedir(), ".town");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface TownConfig {
  auth?: {
    /** CORE host the PAT was minted from, e.g. https://app.getcore.me */
    coreUrl: string;
    /** Town server the CLI talks to, e.g. https://town.example or http://localhost:3000 */
    townUrl: string;
    /** The CORE PAT. Town's `/api/*` accepts this directly as a Bearer. */
    pat: string;
  };
  /** Keys used by `town test npc` to talk to the model. Env vars always
   *  win over these — the config is a convenience so users don't have
   *  to export a key in every shell. File is chmod 0600. */
  llm?: {
    /** Which provider to use when both keys are set. Optional. */
    provider?: "anthropic" | "openai";
    anthropicKey?: string;
    openaiKey?: string;
  };
}

/** Populate process.env from the config file for any key the shell
 *  hasn't already set. Env always wins. Call this at the top of
 *  commands that resolve an LLM. */
export function hydrateEnvFromConfig(): void {
  const cfg = getConfig();
  if (!cfg.llm) return;
  if (cfg.llm.anthropicKey && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = cfg.llm.anthropicKey;
  }
  if (cfg.llm.openaiKey && !process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = cfg.llm.openaiKey;
  }
  if (cfg.llm.provider && !process.env.LLM_PROVIDER) {
    process.env.LLM_PROVIDER = cfg.llm.provider;
  }
}

/** Persist a key for the given provider, and set it as the preferred
 *  provider so a subsequent call picks it up without an env override. */
export function setLlmKey(
  provider: "anthropic" | "openai",
  key: string,
): TownConfig {
  const next = getConfig();
  const llm = { ...(next.llm ?? {}) };
  if (provider === "anthropic") llm.anthropicKey = key;
  else llm.openaiKey = key;
  llm.provider = provider;
  return updateConfig({ llm });
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getConfig(): TownConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as TownConfig;
  } catch {
    return {};
  }
}

export function updateConfig(patch: TownConfig): TownConfig {
  const next: TownConfig = { ...getConfig(), ...patch };
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  // 0600 — the file holds a PAT.
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // chmod can fail on Windows; tolerable.
  }
  return next;
}

export function clearAuth(): void {
  const next = getConfig();
  delete next.auth;
  if (existsSync(CONFIG_DIR)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  }
}
