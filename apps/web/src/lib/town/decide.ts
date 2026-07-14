// LLM-driven decision agent — given an inbound TownEvent and the user's
// current plot + NPCs, the agent thinks through the event and emits
// proposed mutations as Effect[] by calling the four tools below. Nothing
// is applied here — the worker materialises each effect as a
// PlotSuggestion row, and the player approves/declines from in-game.
//
// Tools the agent has:
//   • read_npc({ npcId })           — read tool (no proposal). Lets the
//                                     agent peek at an NPC's prompt before
//                                     deciding to evolve it.
//   • add_building({ plotKey, … })  — proposal → Effect "add-building"
//   • add_npc({ buildingId, … })    — proposal → Effect "add-npc"
//   • update_npc({ npcId, … })      — proposal → Effect "update-npc"
//
// The agent does NOT have a tool to mutate the world. All it can do is
// propose. The player has final say.

import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import { catalog } from "@town/catalog";
import type { Plot } from "@town/plot";
import type { TownEvent } from "@town/types";

import { getChatModel } from "@/lib/chat-model";

export interface NpcRowLite {
  id: string;
  buildingId: string;
  name: string;
  description: string;
  prompt: string;
}

export interface DecideContext {
  plot: Plot;
  npcs: NpcRowLite[];
}

export type Effect =
  // New building. Applying also seeds one default NPC for it via the
  // role-template map seedNpcs() uses.
  | { kind: "add-building"; plotKey: string; reason: string }
  // Patch the description and/or prompt of an existing NPC.
  | {
      kind: "update-npc";
      npcId: string;
      fields: Partial<Pick<NpcRowLite, "description" | "prompt">>;
      reason: string;
    }
  // Add a second (or third, …) NPC to an already-placed building.
  | {
      kind: "add-npc";
      buildingId: string;
      name: string;
      description: string;
      prompt: string;
      reason: string;
    };

/** Run the decision agent against an event. Returns the list of effects
 *  the LLM proposed via its tools. The caller persists each effect as a
 *  PlotSuggestion. Errors are logged and surfaced as an empty list — a
 *  bad LLM call should never block the inbound webhook pipeline. */
export async function decide(
  event: TownEvent,
  ctx: DecideContext,
): Promise<Effect[]> {
  const effects: Effect[] = [];

  const tools = {
    read_npc: tool({
      description:
        "Look up an NPC's full system prompt and description. Use this before " +
        "proposing update_npc so the new wording reads as an evolution of the " +
        "existing voice, not a replacement.",
      inputSchema: z.object({
        npcId: z.string().describe("NPC id from the roster below."),
      }),
      execute: async ({ npcId }) => {
        const npc = ctx.npcs.find((n) => n.id === npcId);
        if (!npc) return { found: false as const };
        return {
          found: true as const,
          id: npc.id,
          buildingId: npc.buildingId,
          name: npc.name,
          description: npc.description,
          prompt: npc.prompt,
        };
      },
    }),

    add_building: tool({
      description:
        "Propose adding a new building to the town. Use only when a real " +
        "thread of the user's life is missing a place. Pick a plotKey from " +
        "the catalog list and skip if the matching building (or one of its " +
        "instances) already exists.",
      inputSchema: z.object({
        plotKey: z
          .string()
          .describe("Catalog plotKey (e.g. studio, gym, cafe, workshop)."),
        reason: z
          .string()
          .describe(
            "One short sentence shown to the player explaining why this fits.",
          ),
      }),
      execute: async ({ plotKey, reason }) => {
        effects.push({ kind: "add-building", plotKey, reason });
        return { proposed: "add-building" as const, plotKey };
      },
    }),

    add_npc: tool({
      description:
        "Propose adding a second (or third) NPC to an existing building. " +
        "Use sparingly — most buildings have exactly one resident. Only " +
        "suggest when the event implies a distinct second character (a " +
        "collaborator, a bandmate, a partner) belongs there.",
      inputSchema: z.object({
        buildingId: z
          .string()
          .describe("Existing building id from the plot summary below."),
        name: z.string().describe("Display name shown on the speaker line."),
        description: z
          .string()
          .describe("Short flavor-text shown when the player approaches."),
        prompt: z
          .string()
          .describe(
            "Full system prompt for the LLM when the player chats with this NPC.",
          ),
        reason: z.string(),
      }),
      execute: async ({ buildingId, name, description, prompt, reason }) => {
        effects.push({
          kind: "add-npc",
          buildingId,
          name,
          description,
          prompt,
          reason,
        });
        return { proposed: "add-npc" as const, buildingId, name };
      },
    }),

    update_npc: tool({
      description:
        "Propose patching an NPC's description and/or system prompt. Read " +
        "the current text first via read_npc — your patch should evolve the " +
        "voice, not overwrite it. Leave a field undefined to keep it.",
      inputSchema: z.object({
        npcId: z.string(),
        description: z.string().optional(),
        prompt: z.string().optional(),
        reason: z.string(),
      }),
      execute: async ({ npcId, description, prompt, reason }) => {
        const fields: Partial<Pick<NpcRowLite, "description" | "prompt">> = {};
        if (description !== undefined) fields.description = description;
        if (prompt !== undefined) fields.prompt = prompt;
        if (Object.keys(fields).length === 0) {
          return {
            skipped: true as const,
            why: "no description or prompt provided",
          };
        }
        effects.push({ kind: "update-npc", npcId, fields, reason });
        return { proposed: "update-npc" as const, npcId };
      },
    }),
  };

  const system = buildSystemPrompt(ctx);
  const userMsg = buildUserMessage(event);

  try {
    await generateText({
      model: getChatModel().model,
      tools,
      stopWhen: stepCountIs(8),
      system,
      prompt: userMsg,
    });
  } catch (err) {
    console.error("[decide] agent failed", err);
    return [];
  }

  return effects;
}

// -----------------------------------------------------------------------------
// Prompt builders
// -----------------------------------------------------------------------------

function buildSystemPrompt(ctx: DecideContext): string {
  const plotKeys = catalog.plots.map((p) => `${p.id} — ${p.label}`).join("\n");

  const placedBuildings = ctx.plot.buildings
    .map((b) => `- ${b.id}  (plotKey=${b.plotKey})`)
    .join("\n");

  const npcRoster = ctx.npcs
    .map(
      (n) =>
        `- ${n.id}  building=${n.buildingId}  name="${n.name}"  description="${trim(n.description, 80)}"`,
    )
    .join("\n");

  return [
    "You are the curator of a personal town that grows as a person tells their butler about their life.",
    "Each event you receive describes a memory the user just shared (or extended). Your job is to propose small, tasteful changes to the town in response — never to apply them directly.",
    "",
    "## What you can do",
    "1. `read_npc(npcId)` — peek at an NPC's full prompt + description before updating them. Free to call.",
    "2. `add_building(plotKey, reason)` — propose a new building.",
    "3. `add_npc(buildingId, name, description, prompt, reason)` — propose a new NPC inside an existing building.",
    "4. `update_npc(npcId, description?, prompt?, reason)` — propose evolving an NPC's voice.",
    "",
    "All proposals queue as suggestions for the player to approve. Do nothing if nothing meaningful changed.",
    "",
    "## Catalog plotKeys you may reference",
    plotKeys,
    "",
    "## Buildings currently in this user's town",
    placedBuildings || "(none yet)",
    "",
    "## NPC roster (short)",
    npcRoster || "(none yet)",
    "",
    "## Rules of taste",
    "- Don't propose a building if a building with the same base plotKey already exists (e.g. don't add `studio` if any `studio` variant is placed).",
    "- Don't propose `add_npc` unless the event clearly names a distinct second character. The HOME NPC absorbing a fact is `update_npc`, not `add_npc`.",
    "- When in doubt, propose nothing. The player would rather be surprised once than nagged ten times.",
    "- Each reason must be a single sentence the player will read in the suggestions sidebar.",
  ].join("\n");
}

function buildUserMessage(event: TownEvent): string {
  const lines: string[] = [];
  lines.push(`Event type: ${event.type}`);
  lines.push(`Memory id: ${event.payload.memoryUuid}`);
  if (event.payload.summary) {
    lines.push("", "Summary:", event.payload.summary);
  }

  const topics =
    event.type === "memory.added"
      ? event.payload.topics
      : event.payload.topicsAdded;
  if (topics.length > 0) {
    lines.push("", `Topics ${event.type === "memory.added" ? "" : "added "}(${topics.length}):`);
    for (const t of topics) {
      const sim = t.similar
        .slice(0, 5)
        .map((s) => `${s.name}(${s.count})`)
        .join(", ");
      lines.push(
        `- "${t.name}"  count=${t.count}` +
          (sim ? `  similar: ${sim}` : ""),
      );
    }
  }

  if (event.payload.identityAspects.length > 0) {
    lines.push("", "Identity statements (the user's own words):");
    for (const a of event.payload.identityAspects) {
      lines.push(`- ${a}`);
    }
  }

  lines.push(
    "",
    "Decide which (if any) tools to call. Suggestions you make will be shown to the player for approval.",
  );
  return lines.join("\n");
}

function trim(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
