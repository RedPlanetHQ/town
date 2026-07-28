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
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import {
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  hasOllama,
  ollamaModel,
} from "@/lib/ollama";
import type { BYOKProvider } from "@/lib/byok/store";

const ANTHROPIC_MODEL_DEFAULT = "claude-haiku-4-5-20251001";
const ANTHROPIC_MODEL = ANTHROPIC_MODEL_DEFAULT;
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
  opts?: {
    userKey?: {
      provider: BYOKProvider;
      apiKey: string;
      /** Proxy base URL (openai_proxy: required, ollama: optional). Ignored
       *  by anthropic / openai — those providers only honor `model`. */
      baseUrl?: string | null;
      /** Pinned model id — proxy routing key for openai_proxy / ollama,
       *  provider-native model override for anthropic / openai. */
      model?: string | null;
    };
  },
): GetChatModelResult {
  const userKey = opts?.userKey;

  if (userKey?.provider === "anthropic" && userKey.apiKey) {
    // Direct api.anthropic.com — honor a pinned model id, else default.
    const client = createAnthropic({ apiKey: userKey.apiKey });
    const modelName = userKey.model?.trim() || ANTHROPIC_MODEL_DEFAULT;
    return { model: client(modelName), usedBYOK: true };
  }
  if (userKey?.provider === "openai" && userKey.apiKey) {
    // Direct api.openai.com — honor a pinned model, else default. If the
    // user needs a proxy they should use the "openai_proxy" row instead.
    const client = createOpenAI({ apiKey: userKey.apiKey });
    const modelName = userKey.model?.trim() || OPENAI_MODEL_DEFAULT;
    return { model: client(modelName), usedBYOK: true };
  }
  if (userKey?.provider === "openai_proxy" && userKey.apiKey) {
    // OpenAI-compatible proxy (LiteLLM, core-gateway, Vercel AI Gateway…).
    // baseUrl is required by the store; assert here as a defense-in-depth
    // check so a legacy row without it doesn't silently fall through.
    const proxyBase = userKey.baseUrl?.trim();
    if (!proxyBase) throw new Error("openai_proxy BYOK missing baseUrl");
    const client = createOpenAI({ baseURL: proxyBase, apiKey: userKey.apiKey });
    const modelName = userKey.model?.trim() || OPENAI_MODEL_DEFAULT;
    return { model: client(modelName), usedBYOK: true };
  }
  if (userKey?.provider === "ollama" && userKey.apiKey) {
    // Ollama Cloud (or a self-hosted daemon behind a bearer). Uses
    // OpenAI-compatible transport under the hood, same as the platform
    // Ollama path — but scoped to the user's own key + endpoint.
    const provider = createOpenAICompatible({
      name: "ollama",
      baseURL: userKey.baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL,
      apiKey: userKey.apiKey,
      supportsStructuredOutputs: true,
      includeUsage: true,
    });
    const modelName = userKey.model?.trim() || DEFAULT_OLLAMA_MODEL;
    return { model: provider(modelName), usedBYOK: true };
  }

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
