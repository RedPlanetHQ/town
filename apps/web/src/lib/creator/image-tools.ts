// Creator-chat image generation tools.
//
// Three tools live here:
//   • generate_exterior  — gpt-image-1 → sharp → Sprite row → staged change
//   • generate_interior  — same, locked to the 18×16 interior box
//   • add_custom_plot    — stages the plot.json shape that references the
//                          two generated sprites by their local filenames
//
// The two image tools store final PNG bytes server-side (Sprite table),
// and stage a change carrying just the `contentHash`. On approval the
// CLI fetches the bytes by hash and materialises them as
// `customPlots/<id>/exterior.png` / `interior.png`. The plot.json's
// sprite refs use the relative form (`./exterior.png` / `./interior.png`)
// so the existing `town deploy` upload pipeline picks them up unchanged.
//
// Lifecycle note: removing a staged change does NOT delete the Sprite
// row. Bytes leak until an admin sweep (v1 decision — single-digit MB
// per user). See ADR notes in the creator route comments.
//
// Aura: 25 per generated image (gpt-image-1 medium ≈ $0.04 + post-process),
// 10 for add_custom_plot (no model call, but blocks an approval slot).
//
// Prompt builders + sharp pipeline live in `./image-gen.ts` so the
// CLI-facing endpoint reuses the same recipe.

import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";

import { storeSpriteForUser } from "../sprite";
import {
  EXTERIOR_DEFAULT_H,
  EXTERIOR_DEFAULT_W,
  EXTERIOR_MAX,
  EXTERIOR_MIN,
  IMAGE_GEN_AURA_COST,
  INTERIOR_TILES_H,
  INTERIOR_TILES_W,
  generateExteriorPng,
  generateInteriorPng,
} from "./image-gen";
import type { ToolContext } from "./read-tools";

const GEN_COST = IMAGE_GEN_AURA_COST;
const ADD_PLOT_COST = 10;

class AuraEmptyError extends Error {
  constructor() {
    super("aura-empty");
    this.name = "AuraEmptyError";
  }
}

interface PendingChange {
  id: string;
  kind: string;
  payload: object;
  summary: string;
  createdAt: string;
}

/** Append one entry to `Town.pendingChanges` and debit aura. Mirrors
 *  `stageChange` in mutation-tools.ts — split here to avoid a circular
 *  import, since the image tools also stage but with their own cost. */
async function stageChange(
  ctx: ToolContext,
  kind: string,
  payload: object,
  summary: string,
  cost: number,
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
      const aura = await tx.aura.update({
        where: { townId: ctx.townId },
        data: { current: { decrement: cost } },
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

// -----------------------------------------------------------------------------
// Tools
// -----------------------------------------------------------------------------

export const generateExteriorTool = (ctx: ToolContext) =>
  tool({
    description:
      "Generate a pixel-art exterior PNG for a custom building and stage it as a pending change. The PNG is fitted into an `exteriorTiles.w × exteriorTiles.h` tile box (default 12×12), with transparent margins. Pair with generate_interior (same customPlotId) and add_custom_plot before adding a building that references it.",
    inputSchema: z.object({
      customPlotId: z
        .string()
        .regex(/^[a-z0-9-]{1,40}$/)
        .describe(
          "Stable id for the custom plot — lowercase letters, digits, hyphens. Same id passes through generate_interior + add_custom_plot. Becomes the building's plotKey suffix: `custom:<id>`.",
        ),
      concept: z
        .string()
        .min(4)
        .max(400)
        .describe(
          "1–3 sentences describing the building's vibe + materials + purpose. Drives the prompt directly.",
        ),
      category: z
        .enum([
          "HOME",
          "WORK",
          "READ",
          "MARKET",
          "MOVE",
          "CREATE",
          "WORKSHOP",
        ])
        .describe("Catalog category the building belongs to."),
      exteriorTiles: z
        .object({
          w: z.number().int().min(EXTERIOR_MIN).max(EXTERIOR_MAX),
          h: z.number().int().min(EXTERIOR_MIN).max(EXTERIOR_MAX),
        })
        .optional()
        .describe(
          "Target tile dimensions for the building's bounding box. Defaults to 12×12.",
        ),
    }),
    execute: async (input) => {
      const tilesW = input.exteriorTiles?.w ?? EXTERIOR_DEFAULT_W;
      const tilesH = input.exteriorTiles?.h ?? EXTERIOR_DEFAULT_H;
      let stored;
      try {
        const fitted = await generateExteriorPng({
          concept: input.concept,
          category: input.category,
          tilesW,
          tilesH,
        });
        stored = await storeSpriteForUser(ctx.userId, new Uint8Array(fitted));
      } catch (e) {
        return {
          error: "image-gen-failed" as const,
          detail: e instanceof Error ? e.message : "unknown",
        };
      }
      const summary = `Generate exterior for ${input.customPlotId} (${tilesW}×${tilesH})`;
      return stageChange(
        ctx,
        "generate_exterior",
        {
          customPlotId: input.customPlotId,
          contentHash: stored.contentHash,
          spriteW: tilesW,
          spriteH: tilesH,
        },
        summary,
        GEN_COST,
      );
    },
  });

export const generateInteriorTool = (ctx: ToolContext) =>
  tool({
    description: `Generate a pixel-art top-down interior PNG for a custom building and stage it as a pending change. Locked to the catalog's ${INTERIOR_TILES_W}×${INTERIOR_TILES_H}-tile interior box. Pair with generate_exterior (same customPlotId) and add_custom_plot.`,
    inputSchema: z.object({
      customPlotId: z
        .string()
        .regex(/^[a-z0-9-]{1,40}$/)
        .describe("Same id used in generate_exterior + add_custom_plot."),
      concept: z
        .string()
        .min(4)
        .max(400)
        .describe(
          "1–3 sentences describing the interior — props, mood, lighting. Should match the exterior's vibe.",
        ),
      category: z.enum([
        "HOME",
        "WORK",
        "READ",
        "MARKET",
        "MOVE",
        "CREATE",
        "WORKSHOP",
      ]),
    }),
    execute: async (input) => {
      let stored;
      try {
        const fitted = await generateInteriorPng({
          concept: input.concept,
          category: input.category,
        });
        stored = await storeSpriteForUser(ctx.userId, new Uint8Array(fitted));
      } catch (e) {
        return {
          error: "image-gen-failed" as const,
          detail: e instanceof Error ? e.message : "unknown",
        };
      }
      const summary = `Generate interior for ${input.customPlotId}`;
      return stageChange(
        ctx,
        "generate_interior",
        {
          customPlotId: input.customPlotId,
          contentHash: stored.contentHash,
          widthTiles: INTERIOR_TILES_W,
          heightTiles: INTERIOR_TILES_H,
        },
        summary,
        GEN_COST,
      );
    },
  });

// Default interior layout — door / spawn / exit / walkable region picked
// from the @town/catalog convention (see ~/Documents/core-town samples).
// The agent supplies NPC positions inside the walkable area.
function defaultInteriorLayout() {
  return {
    widthTiles: INTERIOR_TILES_W,
    heightTiles: INTERIOR_TILES_H,
    // 1-tile-thick wall on all sides, leaving a 16×13 walkable interior
    // (matches the core-town pattern of 16×11 + extra door cells).
    walkable: { tx: 1, ty: 3, w: 16, h: 11 },
    // South door — two stacked 1-tile cells reached from inside the room.
    extraWalkable: [
      { tx: 9, ty: 14, w: 1, h: 1 },
      { tx: 9, ty: 15, w: 1, h: 1 },
    ],
    spawn: { tx: 9, ty: 13 },
    exit: { tx: 9, ty: 14 },
    props: [],
  };
}

export const addCustomPlotTool = (ctx: ToolContext) =>
  tool({
    description:
      "Stage the custom plot definition (plot.json) that references the exterior + interior sprites generated by the matching generate_exterior / generate_interior calls. Call this AFTER both image tools so the apply step lands all three together. The agent should immediately follow with add_building({ plotKey: `custom:<id>` }) + at least one add_npc.",
    inputSchema: z.object({
      customPlotId: z
        .string()
        .regex(/^[a-z0-9-]{1,40}$/)
        .describe(
          "Same id as in the generate calls. Becomes the building's plotKey suffix: `custom:<id>`.",
        ),
      label: z.string().min(1).max(60).describe("Human-readable label."),
      category: z.enum([
        "HOME",
        "WORK",
        "READ",
        "MARKET",
        "MOVE",
        "CREATE",
        "WORKSHOP",
      ]),
      exteriorTiles: z
        .object({
          w: z.number().int().min(EXTERIOR_MIN).max(EXTERIOR_MAX),
          h: z.number().int().min(EXTERIOR_MIN).max(EXTERIOR_MAX),
        })
        .describe(
          "Must match the exteriorTiles you passed to generate_exterior so the variant's spriteW/H are correct.",
        ),
      npcPositions: z
        .array(
          z.object({
            id: z
              .string()
              .max(40)
              .describe(
                "Slot id — use empty string for the implicit single-slot binding. NPCs added with the same slotId bind to this position.",
              ),
            label: z.string().min(1).max(40),
            tx: z.number().int().min(0).max(INTERIOR_TILES_W - 1),
            ty: z.number().int().min(0).max(INTERIOR_TILES_H - 1),
          }),
        )
        .min(1)
        .max(8)
        .describe(
          "Interior tile positions where NPCs should stand. Must fall inside the walkable region (1..16, 3..13).",
        ),
    }),
    execute: async (input) => {
      // Build a CustomPlotDTO that references the sprites by their local
      // relative filenames. The CLI writes the actual PNGs at apply time;
      // `town deploy` then uploads them and rewrites refs to `sprite:<hash>`.
      const interior = defaultInteriorLayout();
      const variant = {
        id: `${input.customPlotId}.default`,
        exteriorSprite: "./exterior.png",
        spriteW: input.exteriorTiles.w,
        spriteH: input.exteriorTiles.h,
        npcPositions: input.npcPositions,
      };
      const customPlot = {
        id: input.customPlotId,
        label: input.label,
        category: input.category,
        interior: {
          sprite: "./interior.png",
          ...interior,
        },
        variants: [variant],
      };
      const summary = `Add custom plot "${input.label}" (custom:${input.customPlotId})`;
      return stageChange(
        ctx,
        "add_custom_plot",
        { customPlot },
        summary,
        ADD_PLOT_COST,
      );
    },
  });
