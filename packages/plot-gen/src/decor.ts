// Forest + decor scatter. Direct port of the catalog playground's
// pgRenderMap passes so the runtime kaplay overworld renders the same plot
// the playground previews / exports as JSON. Four passes in order:
//
//   1. Forest trees (distance-falloff, jitter)
//   2. Forest floor scatter (stumps 1/50, mushrooms 1/30, rocks 1/80)
//   3. Clearing-fringe rocks (5 per plot, at 88-98% of clearing radius)
//   4. Per-clearing bushes + flowers (3 each, radial rejection sampling)
//
// Output is a flat PlotDecor list — the renderer reads tx/ty/group/spriteId
// and draws each sprite at its native tile dims.

import { hash32 } from "./rng";
import type { Manifest, ManifestEntry } from "@town/plot";
import type { PlotDecor } from "@town/plot";
import {
  clearingRadiusAt,
  inAnyBuilding,
  inAnyClearing,
  type ClearingShape,
} from "./clearings";
import { WORLD } from "./world";

const GREEN_TREE_IDS = new Set([
  "tree-01", "tree-02", "tree-03", "tree-05",
  "tree-06", "tree-07", "tree-08", "tree-10",
  "tree-11", "tree-12",
]);
const SPRING_TREE_IDS = new Set(["tree-04", "tree-09"]);

/** Weighted picker — smaller trees more common, greens doubled. */
function pickTree(trees: ManifestEntry[], hashInt: number): ManifestEntry {
  let total = 0;
  const weights = trees.map((t) => {
    const area = t.tileW * t.tileH;
    let w = Math.max(1, 24 - area * 1.5);
    if (GREEN_TREE_IDS.has(t.id)) w *= 2;
    total += w;
    return w;
  });
  let r = (hashInt >>> 0) % Math.max(1, Math.floor(total));
  for (let i = 0; i < trees.length; i++) {
    if (r < weights[i]!) return trees[i]!;
    r -= weights[i]!;
  }
  return trees[0]!;
}

function canopyHits(
  set: Set<string>,
  tx: number,
  ty: number,
  tw: number,
  th: number,
): boolean {
  for (let dy = 0; dy < th; dy++) {
    for (let dx = 0; dx < tw; dx++) {
      if (set.has(tx + dx + "," + (ty + dy))) return true;
    }
  }
  return false;
}

export interface DecorInput {
  seed: string;
  manifest: Manifest;
  buildings: ClearingShape[];
  pathTiles: Set<string>;
  pondTiles: Set<string>;
}

export function scatterDecor(input: DecorInput): PlotDecor[] {
  const { seed, manifest, buildings, pathTiles, pondTiles } = input;
  const out: PlotDecor[] = [];

  // One-tile inflated pond mask — keeps tree canopies from leaning into water.
  // Also used by the per-tile scatter pass below.
  const pondBuffer = new Set<string>();
  for (const key of pondTiles) {
    const [xs, ys] = key.split(",");
    const x = parseInt(xs!, 10);
    const y = parseInt(ys!, 10);
    pondBuffer.add(x + "," + y);
    pondBuffer.add(x + 1 + "," + y);
    pondBuffer.add(x - 1 + "," + y);
    pondBuffer.add(x + "," + (y + 1));
    pondBuffer.add(x + "," + (y - 1));
  }

  const FOREST_X_MAX = WORLD.W - 2;
  const FOREST_Y_MAX = WORLD.H - 3;
  const forestTrees = manifest.trees.filter((t) => !SPRING_TREE_IDS.has(t.id));
  const fallbackTree = forestTrees[0];
  if (!fallbackTree) return out;

  const worldCx = WORLD.W / 2;
  const worldCy = WORLD.H / 2;
  const worldMaxDist = Math.hypot(worldCx, worldCy);

  // ---- 1. Forest trees: distance-falloff gap probability ----
  for (let y = 0; y < FOREST_Y_MAX; y++) {
    for (let x = 0; x < FOREST_X_MAX; x++) {
      const key = x + "," + y;
      if (pathTiles.has(key) || pondTiles.has(key)) continue;
      // Sample clearing check one row south at canopy bottom centre so
      // crowns can peek into the edge.
      if (inAnyClearing(buildings, x + 0.5, y + 1.5)) continue;
      const fh = hash32("forest::" + seed + "::" + x + "::" + y);
      const dx = x + 0.5 - worldCx;
      const dy = y + 0.5 - worldCy;
      const distNorm = Math.min(1, Math.hypot(dx, dy) / worldMaxDist);
      const gapPct = 18 + (1 - distNorm) * 42;
      if (fh % 100 < gapPct) continue;

      let chosen = pickTree(forestTrees, fh);
      if (x + chosen.tileW > WORLD.W || y + chosen.tileH > WORLD.H) {
        chosen = fallbackTree;
      }
      if (
        canopyHits(pondBuffer, x, y, chosen.tileW, chosen.tileH) ||
        canopyHits(pathTiles, x, y, chosen.tileW, chosen.tileH)
      ) {
        if (
          canopyHits(pondBuffer, x, y, fallbackTree.tileW, fallbackTree.tileH) ||
          canopyHits(pathTiles, x, y, fallbackTree.tileW, fallbackTree.tileH)
        ) {
          continue;
        }
        chosen = fallbackTree;
      }
      // Sub-tile jitter so canopies don't look gridded. Same bit pattern
      // as the playground: bits 7-10 → jx, bits 11-14 → jy, range ≈ [-0.05, 0.20].
      const jx = +((((fh >>> 7) & 0xf) / 64) - 0.05).toFixed(3);
      const jy = +((((fh >>> 11) & 0xf) / 64) - 0.05).toFixed(3);
      out.push({
        tx: +((x + jx).toFixed(3)),
        ty: +((y + jy).toFixed(3)),
        group: "trees",
        spriteId: chosen.id,
      });
      // Intentionally NOT reserving the canopy in pondBuffer. The catalog
      // playground lets canopies overlap freely so the forest reads as
      // a dense thicket instead of evenly-spaced trees. Earlier versions
      // of this port reserved canopies and capped the count near ~900;
      // playground parity needs ~3300+ at the same seed/stage.
    }
  }

  // ---- 2. Forest floor scatter: stumps 1/50, mushrooms 1/30, rocks 1/80 ----
  const mushrooms = manifest.mushrooms ?? [];
  const scatterRocks = manifest.rocks ?? [];
  const stumps = manifest.stumps ?? [];
  // Stumps block movement (see overworld-plot.ts's blocked-tile pass), so
  // any tile inside their footprint must be safe to walk away from. The
  // canopy-bottom check below uses (x+0.5, y+1.5) which is fine for the
  // ORIGIN tile, but a multi-tile stump can still reach into a building's
  // clearing on tiles the origin check doesn't cover. We therefore reject
  // the stump up front if any tile of its full footprint sits in any
  // building's clearing — that's the only place those tiles need to be
  // walkable. Doors live at the south edge of the footprint, so this is
  // the failure mode that prevents entering a building.
  function stumpFootprintTouchesClearing(
    sx: number,
    sy: number,
    tileW: number,
    tileH: number,
  ): boolean {
    for (let dy = 0; dy < tileH; dy++) {
      for (let dx = 0; dx < tileW; dx++) {
        if (inAnyClearing(buildings, sx + dx + 0.5, sy + dy + 0.5)) {
          return true;
        }
      }
    }
    return false;
  }
  for (let y = 0; y < FOREST_Y_MAX; y++) {
    for (let x = 0; x < FOREST_X_MAX; x++) {
      const key = x + "," + y;
      if (pathTiles.has(key)) continue;
      if (pondBuffer.has(key)) continue;
      if (inAnyClearing(buildings, x + 0.5, y + 1.5)) continue;
      if (stumps.length) {
        const sh = hash32("stump::" + seed + "::" + x + "::" + y);
        if (sh % 50 === 0) {
          const stump = stumps[sh % stumps.length]!;
          if (!stumpFootprintTouchesClearing(x, y, stump.tileW, stump.tileH)) {
            out.push({ tx: x, ty: y, group: "stumps", spriteId: stump.id });
          }
        }
      }
      if (mushrooms.length) {
        const mh = hash32("mush::" + seed + "::" + x + "::" + y);
        if (mh % 30 === 0) {
          const mush = mushrooms[mh % mushrooms.length]!;
          out.push({ tx: x, ty: y, group: "mushrooms", spriteId: mush.id });
        }
      }
      if (scatterRocks.length) {
        const rh = hash32("frock::" + seed + "::" + x + "::" + y);
        if (rh % 80 === 0) {
          const rk = scatterRocks[rh % scatterRocks.length]!;
          out.push({ tx: x, ty: y, group: "rocks", spriteId: rk.id });
        }
      }
    }
  }

  // ---- 3. Clearing-fringe rocks: 5 per plot at 88-98% of clearing radius ----
  if (scatterRocks.length) {
    for (const b of buildings) {
      const cx = b.tx + b.w / 2;
      const cy = b.ty + b.h / 2;
      for (let slot = 0; slot < 5; slot++) {
        const h = hash32("fringe-rock::" + seed + "::" + b.plotKey + "::" + slot);
        const ang = ((h & 0xffff) / 65535) * Math.PI * 2;
        const baseR = clearingRadiusAt(b, ang);
        const r = baseR * (0.88 + ((h >>> 16) & 0xffff) / 65535 * 0.10);
        const tx = cx + Math.cos(ang) * r;
        const ty = cy + Math.sin(ang) * r;
        if (
          tx < 0.5 || ty < 0.5 ||
          tx >= WORLD.W - 1.5 || ty >= WORLD.H - 1.5
        ) continue;
        const fx = Math.floor(tx);
        const fy = Math.floor(ty);
        if (pathTiles.has(fx + "," + fy)) continue;
        if (pondTiles.has(fx + "," + fy)) continue;
        if (inAnyBuilding(buildings, tx, ty, 0.6)) continue;
        const rk = scatterRocks[h % scatterRocks.length]!;
        out.push({
          tx: +tx.toFixed(2),
          ty: +ty.toFixed(2),
          group: "rocks",
          spriteId: rk.id,
        });
      }
    }
  }

  // ---- 4. Per-clearing bushes + flowers: 3 each via radial rejection ----
  function placeInClearing(
    prefix: string,
    count: number,
    sprites: ManifestEntry[],
    group: string,
    b: ClearingShape,
    cx: number,
    cy: number,
    maxAttempts = 12,
  ): void {
    if (!sprites.length) return;
    for (let slot = 0; slot < count; slot++) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const h = hash32(
          prefix + "::" + seed + "::" + b.plotKey + "::" + slot + "::" + attempt,
        );
        const ang = ((h & 0xffff) / 65535) * Math.PI * 2;
        const baseR = clearingRadiusAt(b, ang);
        const r = baseR * (0.55 + ((h >>> 16) & 0xffff) / 65535 * 0.4);
        const tx = cx + Math.cos(ang) * r;
        const ty = cy + Math.sin(ang) * r;
        if (
          tx < 0.5 || ty < 0.5 ||
          tx >= WORLD.W - 1.5 || ty >= WORLD.H - 2.5
        ) continue;
        if (inAnyBuilding(buildings, tx, ty, 0.8)) continue;
        const fx = Math.floor(tx);
        const fy = Math.floor(ty);
        if (pondTiles.has(fx + "," + fy)) continue;
        if (!inAnyClearing(buildings, tx, ty)) continue;
        const sprite = sprites[h % sprites.length]!;
        out.push({
          tx: +tx.toFixed(2),
          ty: +ty.toFixed(2),
          group,
          spriteId: sprite.id,
        });
        break;
      }
    }
  }
  for (const b of buildings) {
    const cx = b.tx + b.w / 2;
    const cy = b.ty + b.h / 2;
    placeInClearing("bush", 3, manifest.bushes, "bushes", b, cx, cy);
    placeInClearing("flower", 3, manifest.flowers, "flowers", b, cx, cy);
  }

  return out;
}
