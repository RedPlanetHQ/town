// PlotSuggestion lifecycle.
//
// recordSuggestions   — worker calls this with the agent's Effect[]; one row
//                       per effect, status="pending".
// listPending         — what the in-game sidebar polls. Newest first.
// approveSuggestion   — runs applyEffect, marks the row resolved.
// declineSuggestion   — just marks the row resolved.
//
// All approve/decline writes are gated on userId — a caller can only
// resolve their own suggestions. The PlotSuggestion row carries townId so
// applyEffect can target the right town's plot/npc rows.

import { prisma } from "@/lib/db";
import type { Effect } from "./decide";
import { applyEffect } from "./apply-effects";

export type SuggestionStatus = "pending" | "approved" | "declined";

export interface SuggestionRow {
  id: string;
  userId: string;
  townId: string;
  kind: Effect["kind"];
  status: SuggestionStatus;
  payload: Effect;
  reason: string;
  sourceEventId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

/** Persist each Effect as a pending PlotSuggestion. Returns the inserted
 *  row count. Safe to call with an empty list (no-op). */
export async function recordSuggestions(
  userId: string,
  townId: string,
  sourceEventId: string,
  effects: Effect[],
): Promise<number> {
  if (effects.length === 0) return 0;
  await prisma.plotSuggestion.createMany({
    data: effects.map((effect) => ({
      userId,
      townId,
      kind: effect.kind,
      payload: effect as unknown as object,
      reason: effect.reason,
      sourceEventId,
    })),
  });
  return effects.length;
}

/** List the user's pending suggestions, newest first. */
export async function listPendingSuggestions(
  userId: string,
): Promise<SuggestionRow[]> {
  const rows = await prisma.plotSuggestion.findMany({
    where: { userId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toSuggestionRow);
}

/** Count of pending suggestions — what the HUD badge reads. */
export async function countPendingSuggestions(userId: string): Promise<number> {
  return prisma.plotSuggestion.count({
    where: { userId, status: "pending" },
  });
}

export type ResolveError =
  | "not-found"
  | "already-resolved"
  | "apply-failed";

export interface ResolveResult {
  ok: true;
  row: SuggestionRow;
  applied: boolean;
  reason?: string;
}

export interface ResolveFailure {
  ok: false;
  error: ResolveError;
  detail?: string;
}

/** Approve a suggestion: run applyEffect against the row's town, then mark
 *  the row resolved. The row is marked resolved even if applyEffect
 *  no-ops (e.g. building already exists) — the user's intent was answered
 *  either way. */
export async function approveSuggestion(
  userId: string,
  suggestionId: string,
): Promise<ResolveResult | ResolveFailure> {
  const row = await prisma.plotSuggestion.findFirst({
    where: { id: suggestionId, userId },
  });
  if (!row) return { ok: false, error: "not-found" };
  if (row.status !== "pending") {
    return { ok: false, error: "already-resolved" };
  }
  const effect = row.payload as unknown as Effect;
  let applied = false;
  let detail: string | undefined;
  try {
    const result = await applyEffect(row.townId, effect);
    applied = result.applied;
    detail = result.reason;
  } catch (err) {
    console.error("[suggestions] applyEffect threw", err);
    return { ok: false, error: "apply-failed", detail: String(err) };
  }
  const updated = await prisma.plotSuggestion.update({
    where: { id: suggestionId },
    data: { status: "approved", resolvedAt: new Date() },
  });
  return { ok: true, row: toSuggestionRow(updated), applied, reason: detail };
}

/** Decline a suggestion — no plot mutation, just stamp the row. */
export async function declineSuggestion(
  userId: string,
  suggestionId: string,
): Promise<ResolveResult | ResolveFailure> {
  const row = await prisma.plotSuggestion.findFirst({
    where: { id: suggestionId, userId },
  });
  if (!row) return { ok: false, error: "not-found" };
  if (row.status !== "pending") {
    return { ok: false, error: "already-resolved" };
  }
  const updated = await prisma.plotSuggestion.update({
    where: { id: suggestionId },
    data: { status: "declined", resolvedAt: new Date() },
  });
  return { ok: true, row: toSuggestionRow(updated), applied: false };
}

function toSuggestionRow(r: {
  id: string;
  userId: string;
  townId: string;
  kind: string;
  status: string;
  payload: unknown;
  reason: string;
  sourceEventId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}): SuggestionRow {
  return {
    id: r.id,
    userId: r.userId,
    townId: r.townId,
    kind: r.kind as Effect["kind"],
    status: r.status as SuggestionStatus,
    payload: r.payload as Effect,
    reason: r.reason,
    sourceEventId: r.sourceEventId,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
  };
}
