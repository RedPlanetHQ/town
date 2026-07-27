// LLM provider router.
//
// Reads LLM_PROVIDER from the environment (defaulting to "anthropic"),
// resolves the model per (task, provider), and dispatches runStructured
// to the right provider implementation.
//
// Adding a new task: extend LLMTask in `./types.ts`, then add the model
// arms to getModelForTask below. The router itself doesn't need to know
// what the task is for.

import type {
  LLMProvider,
  LLMTask,
  RunStructuredArgs,
  RunStructuredResult,
} from "./types";
import { runStructuredAnthropic } from "./anthropic";
import { runStructuredOpenAI } from "./openai";

const VALID_PROVIDERS: ReadonlySet<LLMProvider> = new Set<LLMProvider>([
  "anthropic",
  "openai",
]);

function readProviderEnv(): LLMProvider {
  const raw = (process.env.LLM_PROVIDER ?? "").toLowerCase().trim();
  if (raw && (VALID_PROVIDERS as Set<string>).has(raw)) {
    return raw as LLMProvider;
  }
  return "anthropic";
}

/**
 * For v2 this is just `readProviderEnv()` regardless of task. Per-task
 * overrides (e.g. always run the judge on Anthropic even if the curator
 * runs on OpenAI) can layer in here without touching the provider impls.
 */
export function getProviderForTask(_task: LLMTask): LLMProvider {
  void _task;
  return readProviderEnv();
}

/**
 * Resolve the concrete model id for a (task, provider) pair. Keep the
 * Anthropic side aligned with the Opus 4.7 constraints in `claude-api`
 * (no date suffix, no temperature, etc.).
 */
export function getModelForTask(
  task: LLMTask,
  provider: LLMProvider,
): string {
  switch (task) {
    case "curator":
      if (provider === "anthropic") return "claude-opus-4-7";
      if (provider === "openai") {
        // OPENAI_STRUCTURED_MODEL overrides the curator model — needed for
        // proxies where the model string is the routing key (e.g. LiteLLM's
        // "openai/claude-sonnet-4-6" or "anthropic/claude-opus-4-7").
        return (
          process.env.OPENAI_STRUCTURED_MODEL?.trim() || "gpt-5.4-mini"
        );
      }
      break;
  }
  // Exhaustiveness sanity check.
  throw new Error(
    `No model mapping for task=${task} provider=${provider}`,
  );
}

/**
 * Single entry point for "give me a typed answer from an LLM". Picks the
 * provider, picks the model, dispatches. The caller never imports an SDK
 * directly — it goes through here so swapping providers is a config-only
 * change.
 */
export async function runStructured<T>(
  args: RunStructuredArgs<T>,
): Promise<RunStructuredResult<T>> {
  const provider = getProviderForTask(args.taskKind);
  const model = getModelForTask(args.taskKind, provider);

  if (provider === "anthropic") {
    return runStructuredAnthropic(args, model);
  }
  if (provider === "openai") {
    return runStructuredOpenAI(args, model);
  }
  // Unreachable given the readProviderEnv guard above, but TS doesn't know.
  throw new Error(`Unsupported LLM provider: ${provider}`);
}
