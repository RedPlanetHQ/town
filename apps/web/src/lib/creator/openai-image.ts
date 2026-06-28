// Lazily-constructed OpenAI client scoped to image generation. Kept
// separate from the creator chat model selection because:
//   • images.generate requires the raw `openai` SDK — the Vercel AI SDK
//     v6 doesn't proxy it.
//   • the creator chat can flip between providers (anthropic / openai)
//     via CREATOR_PROVIDER, but image gen always goes through OpenAI
//     today. Splitting modules makes that asymmetry obvious.
//
// Reads OPENAI_API_KEY from the environment. Throws with a clear
// message when missing so the caller can surface "image gen not
// configured" instead of opaque SDK errors.

import OpenAI from "openai";

let cached: OpenAI | null = null;

export function getOpenAIImageClient(): OpenAI {
  if (cached) return cached;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set — image generation unavailable");
  }
  cached = new OpenAI({ apiKey });
  return cached;
}
