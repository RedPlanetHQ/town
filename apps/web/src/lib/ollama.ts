// Ollama provider. Defaults to Ollama Cloud's OpenAI-compatible endpoint
// (https://ollama.com/v1); OLLAMA_BASE_URL points it at a local daemon
// instead. Setup, the free-tier caveats, and why the default model carries
// the "-cloud" suffix all live next to the OLLAMA_* vars in .env.example —
// the code detail worth keeping here is the supportsStructuredOutputs flag
// below.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export const DEFAULT_OLLAMA_BASE_URL = "https://ollama.com/v1";
const DEFAULT_BASE_URL = DEFAULT_OLLAMA_BASE_URL;
export const DEFAULT_OLLAMA_MODEL = "gpt-oss:120b-cloud";

/** 
  Ollama counts as configured when a cloud key is set, or when the
  operator points at a self-hosted daemon (which needs no key). 
**/
export function hasOllama(): boolean {
  return !!process.env.OLLAMA_API_KEY || !!process.env.OLLAMA_BASE_URL;
}

export function ollamaModel(modelId?: string): LanguageModel {
  const provider = createOpenAICompatible({
    name: "ollama",
    baseURL: process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: process.env.OLLAMA_API_KEY,
    supportsStructuredOutputs: true,
    includeUsage: true,
  });
  return provider(modelId || process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL);
}
