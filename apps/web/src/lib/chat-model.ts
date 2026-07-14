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
const OPENAI_MODEL = "gpt-4o-mini";

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
    const client = createOpenAI({ apiKey: userKey.apiKey });
    return { model: client(OPENAI_MODEL), usedBYOK: true };
  }
  // Ollama BYOK isn't wired here yet — Ollama Cloud auth is per-request,
  // and the existing `ollamaModel()` reads OLLAMA_API_KEY directly. Fall
  // through to platform behaviour for now.

  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const explicit = (process.env.LLM_PROVIDER ?? "").toLowerCase().trim();

  // Explicit override wins, as long as the matching key is present.
  if (explicit === "openai" && hasOpenAI) return { model: openai(OPENAI_MODEL), usedBYOK: false };
  if (explicit === "anthropic" && hasAnthropic) return { model: anthropic(ANTHROPIC_MODEL), usedBYOK: false };
  if (explicit === "ollama" && hasOllama()) return { model: ollamaModel(), usedBYOK: false };

  // Otherwise pick whichever key is set; prefer Anthropic by tradition.
  // Ollama goes last so adding OLLAMA_API_KEY never changes a deploy that already runs on Anthropic or OpenAI.
  if (hasAnthropic) return { model: anthropic(ANTHROPIC_MODEL), usedBYOK: false };
  if (hasOpenAI) return { model: openai(OPENAI_MODEL), usedBYOK: false };
  if (hasOllama()) return { model: ollamaModel(), usedBYOK: false };

  throw new Error(
    "No LLM key configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or " +
      "OLLAMA_API_KEY (optionally LLM_PROVIDER=anthropic|openai|ollama " +
      "to force).",
  );
}
