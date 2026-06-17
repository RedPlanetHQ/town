// @town/plot — schema for one user's town.
//
// A Plot is what a single user owns. It is produced by `@town/plot-gen` from
// (catalog + manifest + seed), validated by `validate.ts`, and consumed by
// the webapp renderer. Plot.json is the durable artifact — DB row, file
// shipped by the CLI, fixture in tests.
//
// Contract: every sprite/variant/decoration referenced from here must exist
// in `@town/catalog` (for buildings) or the extras manifest (for decor).
// `validate()` proves that contract holds.

import type { Category } from "@town/catalog";

export interface TilePos {
  tx: number;
  ty: number;
}

export interface TileRect extends TilePos {
  w: number;
  h: number;
}

/** A sprite reference inside a CustomPlot. Either:
 *   • a catalog path — e.g. "exteriors/home/villa-1.png" (lives under
 *     /sprites/catalog/) or a manifest entry id — verified against the
 *     bundled catalog/manifest at validate time.
 *   • an uploaded sprite ref — "sprite:<contentHash>" — served from
 *     /api/sprites/<hash>.png. The CLI rewrites local "./foo.png" refs
 *     into "sprite:<hash>" form during deploy after uploading bytes.
 *
 *  The server never sees raw local paths — by the time a CustomPlot is
 *  persisted, every reference resolves through `resolveSpriteUrl`. */
export type SpriteRef = string;

/** One prop placed inside a CustomPlot's interior. Mirrors
 *  `@town/catalog`'s `InteriorProp` shape but with `SpriteRef` semantics. */
export interface CustomInteriorProp extends TilePos {
  sprite: SpriteRef;
}

/** Interior shell + props for a CustomPlot. All variants of one
 *  CustomPlot share this interior — the "one room, many doors" pattern. */
export interface CustomInterior {
  spriteCandidates: SpriteRef[];
  props: CustomInteriorProp[];
}

/** One slot inside a CustomPlot variant. */
export interface CustomNpcPosition extends TilePos {
  /** Stable slot id. Optional for single-slot variants — the empty
   *  string is the implicit default that the CLI binds to when an MDX
   *  doesn't set `slotId`. */
  id?: string;
  label: string;
}

/** One exterior variant of a CustomPlot. */
export interface CustomVariant {
  id: string;
  exteriorSpriteCandidates: SpriteRef[];
  /** Legacy single-position slot. Optional — variants that ship
   *  `npcPositions` can omit it. At least one of the two must exist. */
  npcPosition?: CustomNpcPosition;
  /** Every NPC slot the variant supports. When absent, readers treat
   *  the variant as having a single slot `[npcPosition]`. */
  npcPositions?: CustomNpcPosition[];
}

/** A user-defined plot. Mirrors `@town/catalog`'s `Plot` shape so the
 *  effective catalog (catalog ∪ plot.customPlots) is uniform from the
 *  generator's point of view. Buildings reference these via
 *  `plotKey: "custom:<id>"`. */
export interface CustomPlot {
  /** Local id; the building's plotKey is "custom:<id>". */
  id: string;
  label: string;
  category: Category;
  interior: CustomInterior;
  variants: CustomVariant[];
}

/** One building on the town map. `plotKey` + `variantId` together resolve
 *  to a `(Plot, Variant)` pair in the catalog. */
export interface PlotBuilding extends TileRect {
  /** Stable id within the plot (e.g. "home" or "office-2"). Persisted so
   *  paths / NPCs can reference a specific instance even if multiple
   *  instances of the same plotKey exist. */
  id: string;
  plotKey: string;        // → @town/catalog plot id
  variantId: string;      // → @town/catalog variant id (must belong to plotKey)
  category: Category;
  /** Actual exterior sprite tile dimensions — used by clearing geometry
   *  so tall sprites get tall clearings. Falls back to (w, h). */
  spriteW?: number;
  spriteH?: number;
  /** Resolved sprite path (relative to /sprites/). Filled in by the
   *  generator so the renderer doesn't have to re-resolve. */
  exteriorSprite: string;
}

/** A 2-wide bezier road from one building to another. Tiles is the
 *  pre-baked set of (tx, ty) the road occupies. */
export interface PlotPath {
  from: string;           // PlotBuilding.id
  to: string;             // PlotBuilding.id
  tiles: Array<[number, number]>;
}

/** A small water feature — rect placement, autotiled at render time. */
export interface PlotPond extends TileRect {}

/** One piece of scatter decor — tree, bush, flower, etc. */
export interface PlotDecor extends TilePos {
  /** Top-level group in the manifest: "trees" | "bushes" | "flowers" | ... */
  group: string;
  /** Sprite id within that group (e.g. "tree-05", "flower-02"). */
  spriteId: string;
}

/** An NPC slot bound to a building. Position is INSIDE the interior, not
 *  on the overworld. */
export interface PlotNpc extends TilePos {
  buildingId: string;     // PlotBuilding.id
  /** Slot id within the variant's `npcPositions`. Empty string means
   *  "the default first slot" — what one-slot variants resolve to and
   *  what a CLI MDX without a `slotId` frontmatter binds to. */
  slotId: string;
  label: string;
  /** Pointer to an MDX file (relative to the plot dir) that holds the
   *  default prompt, role, and ability declarations. Phase 3. */
  mdxRef?: string;
}

export interface PlotWorld {
  w: number;
  h: number;
  tileSize: number;
}

export interface Plot {
  schemaVersion: 1;
  id: string;
  seed: string;
  world: PlotWorld;
  buildings: PlotBuilding[];
  paths: PlotPath[];
  ponds: PlotPond[];
  decor: PlotDecor[];
  npcs: PlotNpc[];
  /** User-defined plots. A `PlotBuilding.plotKey` of `"custom:<id>"`
   *  resolves to one of these instead of an entry in `@town/catalog`. */
  customPlots?: CustomPlot[];
}

/** Prefix used by every `PlotBuilding.plotKey` that resolves to a
 *  `CustomPlot` instead of a catalog `Plot`. */
export const CUSTOM_PLOT_PREFIX = "custom:";

/** True for plotKeys that resolve to a CustomPlot. */
export function isCustomPlotKey(plotKey: string): boolean {
  return plotKey.startsWith(CUSTOM_PLOT_PREFIX);
}

/** Strip the "custom:" prefix; returns null if it isn't a custom key. */
export function customPlotId(plotKey: string): string | null {
  return plotKey.startsWith(CUSTOM_PLOT_PREFIX)
    ? plotKey.slice(CUSTOM_PLOT_PREFIX.length)
    : null;
}
