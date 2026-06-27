// Provider-agnostic model selection for the creator chat.
//
// Operators flip between Anthropic and OpenAI without touching call
// sites:
//   CREATOR_PROVIDER  "anthropic" (default) | "openai"
//   CREATOR_MODEL     provider-specific model id (optional)
//
// Defaults: anthropic → claude-sonnet-4-5, openai → gpt-4o-mini.
// Both providers ship via the Vercel AI SDK v6, so the tool-call loop in
// /api/creator stays identical — streamText() abstracts the wire format
// (Anthropic's tool_use blocks vs OpenAI's function_call deltas).

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export type CreatorProvider = "anthropic" | "openai";

export function getCreatorModel(): LanguageModel {
  const raw = (process.env.CREATOR_PROVIDER ?? "anthropic").toLowerCase();
  const provider: CreatorProvider = raw === "openai" ? "openai" : "anthropic";
  const modelId =
    process.env.CREATOR_MODEL ??
    (provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL);
  return provider === "openai" ? openai(modelId) : anthropic(modelId);
}
