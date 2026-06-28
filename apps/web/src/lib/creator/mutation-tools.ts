// Creator-chat mutation tools.
//
// Each tool appends one entry to `CreatorConversation.pendingChanges`
// (a JSON array) + debits MUTATION_COST aura inside the same Prisma
// transaction. The actual mutation against the live town (Plot / Npc
// rows) happens later when the user clicks "Apply" in the diff view
// and we drain the queue into a single `/api/town?from=creator` POST.
//
// Why JSON instead of a separate table: the queue is conversation-scoped
// and we never query across conversations, so the read pattern is "give
// me this conversation's whole queue." Storing as JSON on the parent row
// removes a table + a join while keeping per-entry ids/timestamps.
//
// Aura semantics:
//   • If the debit would take aura below zero, the transaction throws
//     `aura-empty` and we surface a structured error to the model
//     instead of bubbling. The model can then tell the user "you're out
//     of aura — top up before staging more changes" without us having to
//     fail the entire stream.

import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./read-tools";

const MUTATION_COST = 10;

export type PendingChange = {
  id: string;
  kind: string;
  payload: object;
  summary: string;
  createdAt: string;
};

class AuraEmptyError extends Error {
  constructor() {
    super("aura-empty");
    this.name = "AuraEmptyError";
  }
}

async function stageChange(
  ctx: ToolContext,
  kind: string,
  payload: object,
  summary: string,
) {
  try {
    return await ctx.prisma.$transaction(async (tx) => {
      const town = await tx.town.findUnique({
        where: { id: ctx.townId },
        select: { pendingChanges: true },
      });
      const queue = Array.isArray(town?.pendingChanges)
        ? (town!.pendingChanges as unknown as PendingChange[])
        : [];
      const entry: PendingChange = {
        id: randomUUID(),
        kind,
        payload,
        summary,
        createdAt: new Date().toISOString(),
      };
      await tx.town.update({
        where: { id: ctx.townId },
        data: { pendingChanges: [...queue, entry] as unknown as object },
      });
      // Aura.current is a plain Int — Prisma's `decrement` returns the
      // post-decrement row, so a single read tells us if we went
      // negative without an extra SELECT.
      const aura = await tx.aura.update({
        where: { townId: ctx.townId },
        data: { current: { decrement: MUTATION_COST } },
      });
      if (aura.current < 0) {
        throw new AuraEmptyError();
      }
      return {
        changeId: entry.id,
        kind,
        summary,
        auraRemaining: aura.current,
      };
    });
  } catch (e) {
    if (e instanceof AuraEmptyError) {
      return { error: "aura-empty" as const };
    }
    throw e;
  }
}

export const addBuildingTool = (ctx: ToolContext) =>
  tool({
    description:
      "Stage a new building for the town. Call list_plotkeys + get_plotkey_details first to pick a valid plotKey and (optionally) variantId. The apply step picks a layout cell automatically.",
    inputSchema: z.object({
      plotKey: z.string(),
      label: z.string().optional(),
      variantId: z.string().optional(),
    }),
    execute: async (input) => {
      const summary = `Add ${input.plotKey}${input.label ? ` "${input.label}"` : ""}`;
      return stageChange(ctx, "add_building", input, summary);
    },
  });

export const deleteBuildingTool = (ctx: ToolContext) =>
  tool({
    description:
      "Stage the removal of a building by its id. Use get_current_town to find building ids.",
    inputSchema: z.object({ buildingId: z.string() }),
    execute: async (input) => {
      const summary = `Delete building ${input.buildingId}`;
      return stageChange(ctx, "delete_building", input, summary);
    },
  });

export const updateBuildingTool = (ctx: ToolContext) =>
  tool({
    description:
      "Stage an update to an existing building's label and/or variant. Building ids come from get_current_town.",
    inputSchema: z.object({
      buildingId: z.string(),
      label: z.string().optional(),
      variantId: z.string().optional(),
    }),
    execute: async (input) => {
      const summary = `Update building ${input.buildingId}`;
      return stageChange(ctx, "update_building", input, summary);
    },
  });

export const addNpcTool = (ctx: ToolContext) =>
  tool({
    description:
      "Stage a new NPC inside a building. The `prompt` field becomes the NPC's runtime system prompt — write a DETAILED 200-400 word character brief covering 4 blocks IN ORDER (see system rule 6a): (1) Identity — name + role + building + 1-2 specific backstory sentences; (2) Voice — cadence, register, 2-3 verbal tics/catchphrases; (3) First-message priority — state name+role+building sentence 1, then ask one specific easy question; (4) Signature moves — 3-5 concrete behaviors or phrases in quotes that nobody else does. Flat one-liners like 'friendly barkeep' produce flat NPCs. Match the building's tone.",
    inputSchema: z.object({
      buildingId: z.string(),
      slotId: z.string().optional(),
      name: z.string(),
      description: z
        .string()
        .describe(
          "Short flavor-text (1 sentence, ~15-25 words) shown when the player approaches the NPC. Not the personality — that goes in `prompt`.",
        ),
      prompt: z
        .string()
        .min(400)
        .describe(
          "The full NPC system prompt — minimum 400 chars, target 200-400 words. Must cover identity / voice / first-message rule / signature moves as prose. See add_npc description for the structure.",
        ),
    }),
    execute: async (input) => {
      const summary = `Add NPC "${input.name}"`;
      return stageChange(ctx, "add_npc", input, summary);
    },
  });

export const updateNpcTool = (ctx: ToolContext) =>
  tool({
    description:
      "Stage an update to an existing NPC's name, description, and/or system prompt.",
    inputSchema: z.object({
      npcId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      prompt: z.string().optional(),
    }),
    execute: async (input) => {
      const summary = `Update NPC ${input.npcId}`;
      return stageChange(ctx, "update_npc", input, summary);
    },
  });

export const deleteNpcTool = (ctx: ToolContext) =>
  tool({
    description: "Stage the removal of an NPC by id.",
    inputSchema: z.object({ npcId: z.string() }),
    execute: async (input) => {
      const summary = `Delete NPC ${input.npcId}`;
      return stageChange(ctx, "delete_npc", input, summary);
    },
  });

// Remove a single entry from THIS conversation's pendingChanges queue.
// Use this when the user says "drop the Leo NPC you staged" or
// "actually, don't add the courthouse" — anything that asks to cancel
// a previously-staged change. The change id comes from
// get_current_town's `pendingChanges` array. No aura cost — cleanup
// shouldn't penalize the user for changing their mind.
export const removePendingChangeTool = (ctx: ToolContext) =>
  tool({
    description:
      "Cancel a previously-staged change by removing it from the pending queue. Use when the user asks to drop / undo / remove / cancel something you staged earlier — pass the change id from get_current_town's pendingChanges array. No effect on the live town and no aura cost.",
    inputSchema: z.object({
      changeId: z
        .string()
        .describe(
          "The `id` field of an entry in pendingChanges (NOT a buildingId or npcId).",
        ),
    }),
    execute: async ({ changeId }) => {
      const town = await ctx.prisma.town.findUnique({
        where: { id: ctx.townId },
        select: { pendingChanges: true },
      });
      const queue = Array.isArray(town?.pendingChanges)
        ? (town!.pendingChanges as unknown as PendingChange[])
        : [];
      const before = queue.length;
      const next = queue.filter((c) => c.id !== changeId);
      if (next.length === before) {
        return {
          error: "not-found" as const,
          changeId,
          message:
            "No pending change with that id. Call get_current_town to refresh the queue.",
        };
      }
      await ctx.prisma.town.update({
        where: { id: ctx.townId },
        data: { pendingChanges: next as unknown as object },
      });
      const removed = queue.find((c) => c.id === changeId)!;
      return {
        removedId: removed.id,
        kind: removed.kind,
        summary: removed.summary,
        remainingCount: next.length,
      };
    },
  });
