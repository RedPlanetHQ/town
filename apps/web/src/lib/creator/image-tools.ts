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

import { randomUUID } from "node:crypto";
import { tool } from "ai";
import sharp from "sharp";
import { z } from "zod";

import { storeSpriteForUser } from "../sprite";
import { getOpenAIImageClient } from "./openai-image";
import type { ToolContext } from "./read-tools";

const TILE_PX = 16;
const GEN_COST = 25;
const ADD_PLOT_COST = 10;

// Catalog convention — interior is always 18 tiles wide, 16 tall. The
// box is fixed so the renderer can position the door / spawn / exit at
// known coordinates regardless of which custom plot is loaded.
const INTERIOR_TILES_W = 18;
const INTERIOR_TILES_H = 16;

// Exterior default (from observation of core-town samples: 10–16 tiles
// per side, mostly 11–12). The model can override via `exteriorTiles`.
const EXTERIOR_DEFAULT_W = 12;
const EXTERIOR_DEFAULT_H = 12;
const EXTERIOR_MIN = 8;
const EXTERIOR_MAX = 20;

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
// Image generation pipeline
// -----------------------------------------------------------------------------

/** Build the exterior generation prompt. Self-contained so the model
 *  only needs to pass the concept — every dimensional + stylistic
 *  constraint is baked in.
 *
 *  Visual reference: ~/Documents/core-town/customPlots/yc/exterior.png.
 *  Red-brick 3-storey facade, dark slate roof, cream/grey foundation
 *  strip, signage panel above the door, small ground-level props on
 *  the sides (bike, plant, lantern). 16-bit JRPG town tile look —
 *  limited palette, crisp pixel outlines, no anti-aliasing. The
 *  building always faces the viewer head-on with a slight elevated
 *  camera so its front face dominates. */
function buildExteriorPrompt(args: {
  concept: string;
  category: string;
  exteriorTilesW: number;
  exteriorTilesH: number;
}): string {
  return `Pixel art exterior of a single building, 16-bit JRPG town tile aesthetic. Reference style: Startup YC's brick facade — Stardew Valley / Earthbound town map. Hand-drawn pixel art, NOT a render.

Concept: ${args.concept}
Category: ${args.category}

CAMERA + COMPOSITION:
- Building FACES THE VIEWER head-on — front facade is the dominant visible surface.
- Slight ¾ elevation (about 15-25° from horizontal) so the viewer sees the front face fully, with a thin sliver of the roof's top edge visible above it. NOT a true top-down view; NOT a pure side-on elevation.
- Building centered horizontally in frame with even transparent padding on left + right.
- Building fits inside a ${args.exteriorTilesW} × ${args.exteriorTilesH} tile bounding box at 16px per tile (≈ ${args.exteriorTilesW * TILE_PX} × ${args.exteriorTilesH * TILE_PX}px native).

ARCHITECTURE (always present):
- 1-tile-wide DOOR centered on the south face, ground level.
- A small SIGNAGE PANEL above the door (rectangular plaque, contrasting color) — leave it blank, no readable letters.
- ROOF clearly visible above the facade — slight pitch, banded shingles or flat slab, in a darker tone than the walls.
- FOUNDATION strip along the ground line (1-2 px taller, in a cool grey or stone tone).
- WINDOWS distributed across the facade (2-6 depending on size), with darker frames and warm yellow/orange interior glow (single saturated fill, no gradient) suggesting the building is inhabited.
- 1-2 small ground-level PROPS flanking the door — pick what fits the concept (lantern, potted plant / bush, sign, bench, bicycle, crate, barrel). Each prop should sit on the same ground line as the door.

STYLE + PALETTE:
- HARD pixel edges, NO anti-aliasing, NO gradients, NO drop shadows on the ground, NO text/lettering/signage typography, NO logos, NO realistic textures, NO 3D-render look.
- Strict ≤16-color palette. 3 tones per major surface: base fill + 1 shadow shade + 1 highlight shade. No more.
- 1-pixel dark OUTLINE around the building silhouette and around every major shape change (window frames, door, roof line, signage).
- Concept drives the palette — red brick + slate roof, weathered teal stone, sun-bleached adobe, cool steel, neon trim on dark base, frosted blue, etc. Saturated and warm-leaning by default.

TRANSPARENCY:
- Subject only. Everything OUTSIDE the building silhouette + its ground-level props MUST be fully transparent (alpha 0). No grass, no ground tile, no backdrop, no cast shadow.`;
}

/** Interior is locked to the catalog's 18×16 footprint so door / spawn
 *  / exit land at known coordinates regardless of which plot is loaded.
 *
 *  Visual reference: ~/Documents/core-town/customPlots/yc/interior.png.
 *  Dark brown wall perimeter, warm beige wood-plank floor with visible
 *  plank lines, dark-wood furniture, jewel-tone accent fabrics (navy
 *  chairs, dark-blue area rug), small clay-potted plants, framed wall
 *  art on the north wall. 16-bit JRPG interior — limited palette,
 *  hard pixel shadows under every prop, crisp 1-pixel outlines. */
function buildInteriorPrompt(args: {
  concept: string;
  category: string;
}): string {
  return `Pixel art top-down interior of a single room, 16-bit JRPG interior aesthetic. Reference style: Startup YC's interior — Stardew Valley shop / Earthbound house. Hand-drawn pixel art, NOT a render.

Concept: ${args.concept} — interior matching the exterior's vibe.
Category: ${args.category}

CAMERA + GEOMETRY:
- Pure TOP-DOWN orthographic projection (looking straight down at the room).
- Room footprint EXACTLY ${INTERIOR_TILES_W} × ${INTERIOR_TILES_H} tiles at 16px per tile (${INTERIOR_TILES_W * TILE_PX} × ${INTERIOR_TILES_H * TILE_PX}px native).
- 1-tile-thick PERIMETER WALL on all four sides. North wall renders as a slightly taller strip showing wall thickness (a thin lighter band on top of a darker base) so it reads as 3D from above.
- DOOR opening in the south wall, exactly 1 tile wide, dead-center at tile x=9, y=${INTERIOR_TILES_H - 1}. The opening must reach the bottom edge of the room.

FLOOR (always present, fills inside the walls):
- Warm wood-PLANK floor as the default — visible 1-pixel plank seam lines, horizontal or vertical orientation, base color in the beige/tan/amber range (concept may shift to stone tile, polished concrete, marble, etc. if it fits).
- 2 tones in the planks (alternating slightly between rows) to break up monotony.
- A central FLOOR ACCENT in the middle of the room — a round or rectangular area rug, a circular medallion, a darker tile inset — in a jewel tone that matches the accent palette (navy, teal, emerald, burgundy, deep purple, etc.).

WALLS:
- Wall PERIMETER in a dark wood tone (deep brown / burgundy / charcoal — concept can shift) with a 1-pixel darker outline.
- Wall corners get a 1-2 pixel highlight on the inside to suggest light bouncing off.

FURNITURE + PROPS (must populate the room, but leave the center column walkable):
- DARK WOOD furniture as the structural anchor — desks, counters, shelves, tables, beds, workbenches. Each prop has hard 1-pixel drop shadow on its south + east edges.
- JEWEL-TONE accent fabric on chairs, cushions, rugs, banners — saturated navy / teal / emerald / burgundy / amber (concept-driven choice, pick ONE accent color and use it everywhere).
- 2-4 POTTED PLANTS in terracotta clay pots, deep-green saturated foliage — placed in corners or against walls.
- NORTH WALL decorations — small framed pictures, a clock, a banner, a window with night sky, a notice board — 2-4 of them, evenly spaced.
- Optional wall sconces / lanterns on the side walls as 1-tile warm-yellow glowing dots.

WALKABILITY:
- Leave the CENTER COLUMN clear (tile x=8 through x=10) from the north wall down to the south door. No furniture, no plant, no rug touching that column. This is the player's walking lane.
- Furniture should hug the walls — do not crowd the room with floating tables in the middle.

STYLE + PALETTE:
- HARD pixel edges, NO anti-aliasing, NO gradients, NO realistic shadows, NO readable text/signage/labels, NO 3D-render look.
- Strict ≤16-color palette. Each surface gets at most 3 tones (base + shadow + highlight).
- 1-pixel dark OUTLINE around every prop and around the wall perimeter.
- Warm-leaning by default. Concept can shift the dominant accent + materials but the basic structure (wood floor, dark wood walls, jewel accents, terracotta plants) stays the same so every custom interior in the town reads as a cohesive set.

TRANSPARENCY:
- The area OUTSIDE the room perimeter MUST be fully transparent (alpha 0). No exterior, no ground, no cast shadow.`;
}

/** Call gpt-image-1 with transparent background and return raw PNG bytes.
 *  Throws on any provider error so the caller surfaces a structured
 *  failure to the model. */
async function generateImage(args: {
  prompt: string;
  size: "1024x1024" | "1024x1536" | "1536x1024";
}): Promise<Buffer> {
  const client = getOpenAIImageClient();
  const res = await client.images.generate({
    model: "gpt-image-1",
    prompt: args.prompt,
    size: args.size,
    background: "transparent",
    quality: "medium",
    n: 1,
  });
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("openai returned no image bytes");
  }
  return Buffer.from(b64, "base64");
}

/** Sharp pipeline: trim transparent border, downscale with nearest-neighbor
 *  to native pixel dims, letterbox-pad to exact target with alpha=0. The
 *  trim discards whatever empty space the model left around the silhouette
 *  so the building/room actually fills its tile box. */
async function fitToBox(args: {
  raw: Buffer;
  targetWidth: number;
  targetHeight: number;
}): Promise<Buffer> {
  return await sharp(args.raw)
    .ensureAlpha()
    .trim({ threshold: 1 })
    .resize({
      width: args.targetWidth,
      height: args.targetHeight,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: "nearest",
    })
    .png()
    .toBuffer();
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
      const targetW = tilesW * TILE_PX;
      const targetH = tilesH * TILE_PX;
      let stored;
      try {
        const raw = await generateImage({
          prompt: buildExteriorPrompt({
            concept: input.concept,
            category: input.category,
            exteriorTilesW: tilesW,
            exteriorTilesH: tilesH,
          }),
          size: "1024x1024",
        });
        const fitted = await fitToBox({
          raw,
          targetWidth: targetW,
          targetHeight: targetH,
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
      const targetW = INTERIOR_TILES_W * TILE_PX;
      const targetH = INTERIOR_TILES_H * TILE_PX;
      let stored;
      try {
        const raw = await generateImage({
          prompt: buildInteriorPrompt({
            concept: input.concept,
            category: input.category,
          }),
          // Interior tile box is 18×16 — landscape, 9:8. The closest
          // gpt-image-1 size is 1536×1024 (3:2). Using the portrait
          // 1024×1536 here would letterbox the room down to ~60% width
          // of the final 288×256 canvas, leaving transparent bars on
          // either side and a tiny in-game room.
          size: "1536x1024",
        });
        const fitted = await fitToBox({
          raw,
          targetWidth: targetW,
          targetHeight: targetH,
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
