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
// bottom-anchored on the plot rect — so CELL_H shorter than the
// tallest sprite makes tall buildings extend past the row above's plot
// rect and clip into the neighbour. CELL_H=27 clears a 25-tile sprite
// with a 2-tile vertical safety margin (plus ±1.5-tile jitter room).
// CELL_W=20 is smaller than the widest sprite (27) on purpose — the
// layout's collision-aware placement will just spread wide sprites to
// non-adjacent cells when they'd otherwise crash. Keeping the world
// tighter than a naïve max-sprite grid keeps the total decor scatter
// count (~10k) closer to the historical baseline, so the overworld
// stays smooth to walk through.
export const WORLD = {
  W: 120,        // tiles (= 6 * CELL_W)
  H: 135,        // tiles (= 5 * CELL_H)
  TILE: 16,      // px per tile (only used by the renderer)
  CELL_W: 20,
  CELL_H: 27,
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
