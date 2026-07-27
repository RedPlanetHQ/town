// Pick the chat model for /api/npc-chat. Reads LLM_PROVIDER (same env
// the structured-output router uses) but also auto-picks the one whose
// API key is actually set so a deploy with only OPENAI_API_KEY doesn't
// crash trying to call Anthropic.
//
// BYOK: pass `{ userKey: { provider, apiKey } }` and the returned model
// is bound to the user's own key; caller reads `usedBYOK` on the result
// to skip aura debit for that turn.

import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { hasOllama, ollamaModel } from "@/lib/ollama";
import type { BYOKProvider } from "@/lib/byok/store";

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
// Fallback OpenAI chat model. Platform path (OPENAI_API_KEY) can override
// via OPENAI_CHAT_MODEL — useful for proxies where the model name is the
// routing key, e.g. "openai/claude-sonnet-4-6" via LiteLLM. BYOK always
// uses this hardcoded default because a user's key hits api.openai.com
// directly and wouldn't know about proxy-prefixed model names.
const OPENAI_MODEL_DEFAULT = "gpt-5.4-mini";
function platformOpenAIModel(): string {
  return process.env.OPENAI_CHAT_MODEL?.trim() || OPENAI_MODEL_DEFAULT;
}

export interface GetChatModelResult {
  model: LanguageModel;
  usedBYOK: boolean;
}

export function getChatModel(
  opts?: { userKey?: { provider: BYOKProvider; apiKey: string } },
): GetChatModelResult {
  const userKey = opts?.userKey;

  if (userKey?.provider === "anthropic" && userKey.apiKey) {
    const client = createAnthropic({ apiKey: userKey.apiKey });
    return { model: client(ANTHROPIC_MODEL), usedBYOK: true };
  }
  if (userKey?.provider === "openai" && userKey.apiKey) {
    // BYOK hits api.openai.com with the user's key — must be a real OpenAI
    // model id, never the OPENAI_CHAT_MODEL override (which may be a
    // proxy-prefixed alias like "openai/claude-sonnet-4-6").
    const client = createOpenAI({ apiKey: userKey.apiKey });
    return { model: client(OPENAI_MODEL_DEFAULT), usedBYOK: true };
  }
  // Ollama BYOK isn't wired here yet — Ollama Cloud auth is per-request,
  // and the existing `ollamaModel()` reads OLLAMA_API_KEY directly. Fall
  // through to platform behaviour for now.

  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const explicit = (process.env.LLM_PROVIDER ?? "").toLowerCase().trim();

  // If OPENAI_BASE_URL is set, route through an OpenAI-compatible proxy
  // (LiteLLM, Vercel AI Gateway, etc.). OPENAI_API_KEY is the security
  // key we send to the proxy. Same pattern core uses.
  // OPENAI_CHAT_MODEL overrides the model name — required for proxies where
  // the model string is the routing key (e.g. "openai/claude-sonnet-4-6").
  const openaiModel = (): LanguageModel => {
    const baseURL = process.env.OPENAI_BASE_URL?.trim();
    const modelName = platformOpenAIModel();
    if (baseURL) {
      const client = createOpenAI({ baseURL, apiKey: process.env.OPENAI_API_KEY });
      return client(modelName);
    }
    return openai(modelName);
  };

  // Explicit override wins, as long as the matching key is present.
  if (explicit === "openai" && hasOpenAI) return { model: openaiModel(), usedBYOK: false };
  if (explicit === "anthropic" && hasAnthropic) return { model: anthropic(ANTHROPIC_MODEL), usedBYOK: false };
  if (explicit === "ollama" && hasOllama()) return { model: ollamaModel(), usedBYOK: false };

  // Otherwise pick whichever key is set; prefer Anthropic by tradition.
  // Ollama goes last so adding OLLAMA_API_KEY never changes a deploy that already runs on Anthropic or OpenAI.
  if (hasAnthropic) return { model: anthropic(ANTHROPIC_MODEL), usedBYOK: false };
  if (hasOpenAI) return { model: openaiModel(), usedBYOK: false };
  if (hasOllama()) return { model: ollamaModel(), usedBYOK: false };

  throw new Error(
    "No LLM key configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or " +
      "OLLAMA_API_KEY (optionally LLM_PROVIDER=anthropic|openai|ollama " +
      "to force).",
  );
}
