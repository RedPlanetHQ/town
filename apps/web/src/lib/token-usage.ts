// Per-call LLM usage log + aura debit.
//
// Every LLM call site (streamText / generateObject / generateText) ends
// its turn with a `recordTokenUsage(...)` invocation. Two things happen:
//
//   1. A `TokenUsage` row lands in Postgres so future analytics /
//      quota work can query it.
//   2. The town's `Aura.current` is decremented by an amount derived
//      from the token counts. Rate (per the product spec):
//         100,000 input tokens  → 10 aura
//         10,000 output tokens  → 10 aura
//      i.e. per-token: input costs 0.0001 aura, output costs 0.001 aura.
//      We round to the nearest integer aura debit per call so tiny
//      turns still cost something. The debit is clamped so aura never
//      goes negative — the "sleeping" gate in the chat routes stops
//      further calls before that matters.
//
// Both operations are best-effort — a Postgres blip must NEVER break a
// live chat stream. Callers should await the returned promise inside
// `onFinish` (or after their generateObject await) without a try/catch;
// this helper handles its own errors.
//
// Model id: pass a string. Both @ai-sdk/anthropic and @ai-sdk/openai
// expose `.modelId` on the LanguageModel — `modelIdOf(model)` returns
// that (falling back to "unknown" if the shape ever changes).

import type { LanguageModel } from "ai";
import type { Prisma } from "@town/db";

import { prisma } from "./db";

export type TokenUsageEvent =
  | "single_chat"
  | "group_chat"
  | "decision"
  | "town_building_chat";

export interface RecordTokenUsageInput {
  townId: string;
  userId: string;
  event: TokenUsageEvent;
  model: string;
  inputTokens: number;
  outputTokens: number;
  npcId?: string | null;
  buildingId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Aura floor below which the "town is sleeping" gate trips. Shared
 *  between the debit clamp here and the chat-route guard. */
export const AURA_SLEEP_THRESHOLD = 100;

/** Compute the aura debit for one LLM call.
 *
 * Rates (see /docs/ or PR body — mirrors real LLM pricing shape, with
 * output ~10× more expensive per token than input):
 *   • 1 aura per 500  input tokens
 *   • 1 aura per  50  output tokens
 *
 * Rounded to the nearest integer so a 50-token reply still costs
 * 1 aura instead of vanishing into 0.02 that Postgres would truncate.
 *
 * A typical 4,000 in / 500 out turn costs 8 + 10 = 18 aura; against
 * the default 1,000 max / 100 sleep floor that gives ~50 turns per
 * empty→sleep cycle before the town goes quiet. Regen (10/hour)
 * refills a fully-emptied town in ~90 hours. */
export function computeAuraDebit(input: {
  inputTokens: number;
  outputTokens: number;
}): number {
  const inTokens = Math.max(0, input.inputTokens);
  const outTokens = Math.max(0, input.outputTokens);
  const raw = inTokens / 500 + outTokens / 50;
  return Math.max(0, Math.round(raw));
}

export async function recordTokenUsage(
  input: RecordTokenUsageInput,
): Promise<void> {
  const debit = computeAuraDebit(input);
  try {
    // Two writes; we don't need atomicity between them — a token log
    // without a debit (or a debit without a log) is fine and rare.
    // Kept out of a transaction so a slow Aura row lock can't hold up
    // the log write.
    await prisma.tokenUsage.create({
      data: {
        townId: input.townId,
        userId: input.userId,
        event: input.event,
        model: input.model,
        inputTokens: Math.max(0, input.inputTokens),
        outputTokens: Math.max(0, input.outputTokens),
        npcId: input.npcId ?? null,
        buildingId: input.buildingId ?? null,
        metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (e) {
    console.warn("[token-usage] insert failed", e);
  }
  if (debit > 0) {
    try {
      // Clamp at 0 — never let aura go negative. The sleeping gate on
      // the chat routes stops new calls before this normally matters,
      // but a burst of concurrent onFinish handlers could still race
      // past the threshold. GREATEST(current - debit, 0) is safe.
      await prisma.$executeRaw`
        UPDATE core."Aura"
           SET current    = GREATEST(current - ${debit}, 0),
               "updatedAt" = NOW()
         WHERE "townId" = ${input.townId}
      `;
    } catch (e) {
      console.warn("[token-usage] aura debit failed", e);
    }
  }
}

/** Pull the SDK's model id off a LanguageModel. Anthropic + OpenAI both
 *  put it on `.modelId`; the fallback keeps logging safe if the SDK
 *  ever renames the field. */
export function modelIdOf(model: LanguageModel): string {
  const m = model as unknown as { modelId?: string };
  return m.modelId ?? "unknown";
}

/** Normalise the AI-SDK v6 `usage` blob. streamText's onFinish passes
 *  `{ inputTokens, outputTokens, totalTokens }`; generateText/Object
 *  return the same shape on `.usage`. Returns zeros for missing
 *  fields — token-less calls are logged as 0/0. */
export function tokensFrom(
  usage: { inputTokens?: number; outputTokens?: number } | null | undefined,
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
}
