// @town/catalog — types
//
// The catalog is the source of truth for every asset a plot can reference:
// which buildings (exteriors), which interiors (shells + prop layout), and
// which NPC slots are available per variant. A USER PLOT (defined elsewhere)
// picks one entry from each list — it never invents new sprite paths.
//
// Two things keep this clean:
//   1. Sprite paths here are all-or-nothing — every value must point at an
//      asset that exists on disk in apps/web/public/sprites/.
//   2. The variants[] of a plot all share the same `interior` and props.
//      The variant only owns its exterior + npcPosition. This is the
//      "one room, many doors" pattern we converged on.

/** Coarse domain a plot belongs to. Mirrors the live game's Category union
 *  but kept local to avoid a cross-package dep cycle. */
export type Category =
  | "HOME"
  | "WORK"
  | "READ"
  | "MARKET"
  | "MOVE"
  | "CREATE"
  | "WORKSHOP";

/** Tile-coordinate placement, top-left anchored. Tile = 16px. */
export interface TilePos {
  tx: number;
  ty: number;
}

/** One prop placed inside an interior. `sprite` resolves to
 *  /sprites/interiors/<sprite>.png at runtime. */
export interface InteriorProp extends TilePos {
  sprite: string;
}

/** Shared interior for an entire plot — every variant inside the plot uses
 *  this exact shell + prop list. The only per-variant thing is npcPosition. */
export interface Interior {
  /** First entry is the canonical shell. Others are alternates for swap.
   *  Path is relative to /sprites/catalog/ — e.g. "interiors/home/foo.png". */
  spriteCandidates: string[];
  props: InteriorProp[];
}

/** Where one NPC spawns inside the shared interior. A variant declares
 *  every slot the building supports; the user's roster binds an NPC to
 *  each slot by id (or to the first slot when no id is set). */
export interface NpcPosition extends TilePos {
  /** Stable slot id within the variant. Optional only for back-compat
   *  with the historical single-slot shape — newer variants set it
   *  explicitly (e.g. "barista", "regular"). Slot "" is the implicit
   *  default and matches a CLI MDX without a `slotId` frontmatter. */
  id?: string;
  /** Short descriptive label (e.g. "barista", "warden") — also used as
   *  the default friendly name when no MDX overrides it. */
  label: string;
}

/** One variant within a plot. */
export interface Variant {
  id: string;
  canonical: string;
  profession?: string;
  vibe?: string;
  paletteAccent?: string;
  /** First entry is canonical exterior. Others are alternates. Path is
   *  relative to /sprites/catalog/ — e.g. "exteriors/home/villa-1.png". */
  exteriorSpriteCandidates: string[];
  anchorObjects?: string[];
  triggers?: string[];
  /** Legacy single-position slot. Optional now — variants that ship
   *  `npcPositions` can omit it. Readers fall back to `npcPositions[0]`
   *  when absent. At least one of the two must be present. */
  npcPosition?: NpcPosition;
  /** Every NPC slot the variant supports. When absent, readers treat
   *  the variant as having a single slot `[npcPosition]`. */
  npcPositions?: NpcPosition[];
}

/** A plot is a slot on the town map. All variants share the interior. */
export interface Plot {
  id: string;
  label: string;
  category: Category;
  interior: Interior;
  variants: Variant[];
}

export interface Catalog {
  generatedAt: string;
  plots: Plot[];
}
