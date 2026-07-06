// World constants — match the catalog playground exactly so the layout
// stays visually identical between the playground UI and the live game.
// Changing any of these shifts every newly generated / reflowed town.
// Existing PlotRow rows keep their tx/ty until `town deploy --reflow`
// blows them away, so this constant is safe to bump without a
// migration.
//
// CELL_{W,H} - PLOT_{W,H} = horizontal/vertical gutter between adjacent
// plot footprints. Catalog sprites go up to 27 tiles wide (hospital-1)
// and 25 tiles tall (victorian-house-1/2/3), and every sprite is
// bottom-anchored on the plot rect — so a CELL_{W,H} smaller than the
// tallest / widest sprite makes tall buildings extend past the row
// above's plot rect and clip into the neighbour. CELL_W=30 gives a
// 20-tile gutter (>> max sprite overhang of 8.5 tiles per side plus a
// ±1.5 tile jitter), CELL_H=30 gives 23 tiles of vertical clearance —
// enough for a 25-tile-tall sprite to stand up without punching into
// the row above. Old values (CELL_W=18 / CELL_H=19) worked for short
// sprites but broke as soon as the town used one of the taller
// exteriors.
export const WORLD = {
  W: 180,        // tiles (= 6 * CELL_W)
  H: 150,        // tiles (= 5 * CELL_H)
  TILE: 16,      // px per tile (only used by the renderer)
  CELL_W: 30,
  CELL_H: 30,
  COLS: 6,
  ROWS: 5,
  PLOT_W: 10,
  PLOT_H: 7,
} as const;

/** 30-slot priority list. Slice the first N to control how many plots
 *  are active in a given town. */
export const PLOT_PRIORITY: readonly string[] = [
  // Day-0 trio (fixed positions)
  "home", "library", "store",
  // Tier 1 unlocks
  "office", "cafe", "workshop", "studio",
  "stage", "practice", "station", "gym",
  // Tier 2 growth (repeat instances)
  "workshop-2", "office-2", "studio-2", "library-2",
  "cafe-2", "home-2", "practice-2", "station-2",
  "workshop-3",
  // Tier 3 mature
  "studio-3", "office-3", "cafe-3", "home-3",
  "library-3", "workshop-4", "studio-4", "office-4",
  "cafe-4", "gym-2",
];

/** Strip the trailing instance suffix (e.g. "office-2" → "office") so a
 *  per-instance plot key resolves to its canonical catalog entry. */
export function baseKey(plotKey: string): string {
  return plotKey.replace(/-\d+$/, "");
}
