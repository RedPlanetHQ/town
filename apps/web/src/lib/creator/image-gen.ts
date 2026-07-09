// Shared image-generation primitives for the town creator.
//
// Two callers depend on these:
//   • lib/creator/image-tools.ts — the in-chat creator tools that
//     STAGE images as pending changes for interactive approval.
//   • app/api/creator/images/route.ts — the CLI-facing endpoint that
//     just returns bytes so `town generate` can write them to disk.
//
// Split into its own module so the two callers can share the same
// prompt + sharp pipeline without importing each other, and so anyone
// tweaking the prompt only has one place to edit.

import sharp from "sharp";

import { getOpenAIImageClient } from "./openai-image";

export const TILE_PX = 16;

// Catalog convention — interior is always 18 tiles wide, 16 tall. The
// box is fixed so the renderer can position the door / spawn / exit at
// known coordinates regardless of which custom plot is loaded.
export const INTERIOR_TILES_W = 18;
export const INTERIOR_TILES_H = 16;

// Exterior default (from observation of core-town samples: 10–16 tiles
// per side, mostly 11–12). The model can override via `exteriorTiles`.
export const EXTERIOR_DEFAULT_W = 12;
export const EXTERIOR_DEFAULT_H = 12;
export const EXTERIOR_MIN = 8;
export const EXTERIOR_MAX = 20;

// Aura cost per image generation. Kept here (not just in image-tools)
// so the CLI endpoint debits the same amount as the in-chat tool.
export const IMAGE_GEN_AURA_COST = 25;

export type PlotCategory =
  | "HOME"
  | "WORK"
  | "READ"
  | "MARKET"
  | "MOVE"
  | "CREATE"
  | "WORKSHOP";

/** Build the exterior generation prompt. Self-contained so the model
 *  only needs to pass the concept — every dimensional + stylistic
 *  constraint is baked in.
 *
 *  Visual reference: ~/Documents/core-town/customPlots/yc/exterior.png. */
export function buildExteriorPrompt(args: {
  concept: string;
  category: PlotCategory;
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
 *  Visual reference: ~/Documents/core-town/customPlots/yc/interior.png. */
export function buildInteriorPrompt(args: {
  concept: string;
  category: PlotCategory;
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
export async function generateImage(args: {
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
 *  to native pixel dims, letterbox-pad to exact target with alpha=0. */
export async function fitToBox(args: {
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

/** End-to-end: build prompt → call OpenAI → fit into the target tile box.
 *  Returns PNG bytes at the exact target native resolution. */
export async function generateExteriorPng(args: {
  concept: string;
  category: PlotCategory;
  tilesW: number;
  tilesH: number;
}): Promise<Buffer> {
  const raw = await generateImage({
    prompt: buildExteriorPrompt({
      concept: args.concept,
      category: args.category,
      exteriorTilesW: args.tilesW,
      exteriorTilesH: args.tilesH,
    }),
    size: "1024x1024",
  });
  return await fitToBox({
    raw,
    targetWidth: args.tilesW * TILE_PX,
    targetHeight: args.tilesH * TILE_PX,
  });
}

/** Interior variant — locked to the catalog's 18×16 footprint. */
export async function generateInteriorPng(args: {
  concept: string;
  category: PlotCategory;
}): Promise<Buffer> {
  const raw = await generateImage({
    prompt: buildInteriorPrompt({
      concept: args.concept,
      category: args.category,
    }),
    // Interior tile box is 18×16 — landscape, 9:8. The closest
    // gpt-image-1 size is 1536×1024 (3:2). Using the portrait
    // 1024×1536 here would letterbox the room down to ~60% width
    // of the final 288×256 canvas.
    size: "1536x1024",
  });
  return await fitToBox({
    raw,
    targetWidth: INTERIOR_TILES_W * TILE_PX,
    targetHeight: INTERIOR_TILES_H * TILE_PX,
  });
}
