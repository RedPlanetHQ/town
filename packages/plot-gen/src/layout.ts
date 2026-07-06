// Town layout — picks the cell and jittered tile coordinate for every
// active plot. Direct port of pgGenerateLayout from the catalog playground.
//
// Invariants:
//   1. Same (seed, plotKey) always produces the same position.
//   2. Different users (different seeds) get different positions for
//      everything except the day-0 trio (home / library / store), which
//      sit in fixed cells so every town reads as a settlement from
//      slot 1.
//   3. Adding a new plot type at the end of PLOT_PRIORITY does NOT move
//      any plot already placed (each plot draws its hash independently).
//   4. Effective-rect collision aware — every candidate cell is tested
//      against every already-placed building's *visual* rect (plot
//      footprint grown by sprite overhang). Without this a tall sprite
//      like victorian-house-1 (16×25) drawn from its plot bottom
//      punches into the row above's plot and clips into neighbours.

import { hash32 } from "./rng";
import { WORLD, PLOT_PRIORITY } from "./world";

export interface CellPos {
  col: number;
  row: number;
}

export interface BuildingRect {
  tx: number;
  ty: number;
  w: number;
  h: number;
  cell: CellPos;
}

/** Bottom-anchored visual rect a building occupies once drawn. Mirrors
 *  `effectiveRect` in incremental.ts — kept in sync so bootstrap
 *  placement and incremental placement agree on collision geometry. */
function effectiveRect(rect: {
  tx: number;
  ty: number;
  w: number;
  h: number;
  spriteW?: number;
  spriteH?: number;
}): { tx: number; ty: number; w: number; h: number } {
  const sw = rect.spriteW ?? rect.w;
  const sh = rect.spriteH ?? rect.h;
  return {
    tx: rect.tx + (rect.w - sw) / 2,
    ty: rect.ty + rect.h - sh,
    w: sw,
    h: sh,
  };
}

function rectsOverlap(
  a: { tx: number; ty: number; w: number; h: number },
  b: { tx: number; ty: number; w: number; h: number },
  pad = 0,
): boolean {
  return (
    a.tx - pad < b.tx + b.w &&
    a.tx + a.w + pad > b.tx &&
    a.ty - pad < b.ty + b.h &&
    a.ty + a.h + pad > b.ty
  );
}

function cellToRect(
  cell: CellPos,
  jitterKey: string,
  dims: { tileW: number; tileH: number } | undefined,
): BuildingRect & { spriteW?: number; spriteH?: number } {
  const baseTx = cell.col * WORLD.CELL_W + (WORLD.CELL_W - WORLD.PLOT_W) / 2;
  const baseTy = cell.row * WORLD.CELL_H + (WORLD.CELL_H - WORLD.PLOT_H) / 2;
  // Per-cell jitter so buildings don't all line up on the grid (±1.5 tiles).
  const h = hash32(jitterKey + "::jit::" + cell.col + "," + cell.row);
  const jx = ((h & 0xffff) / 65535 - 0.5) * 3;
  const jy = (((h >>> 16) & 0xffff) / 65535 - 0.5) * 3;
  return {
    tx: Math.round(Math.max(4, Math.min(WORLD.W - WORLD.PLOT_W - 4, baseTx + jx))),
    ty: Math.round(Math.max(4, Math.min(WORLD.H - WORLD.PLOT_H - 4, baseTy + jy))),
    w: WORLD.PLOT_W,
    h: WORLD.PLOT_H,
    cell,
    ...(dims ? { spriteW: dims.tileW, spriteH: dims.tileH } : {}),
  };
}

function allCells(): CellPos[] {
  const out: CellPos[] = [];
  for (let r = 0; r < WORLD.ROWS; r++) {
    for (let c = 0; c < WORLD.COLS; c++) out.push({ col: c, row: r });
  }
  return out;
}

/** Assign each active plot a (cell, rect). Returns a map keyed by
 *  plotKey (with instance suffix, e.g. "office-2"). `spriteDims` provides
 *  per-plotKey sprite tile dimensions so collision checks reserve enough
 *  space for tall / wide sprites. */
export function generateLayout(
  seed: string,
  activeCount: number,
  spriteDims: Record<string, { tileW: number; tileH: number }> = {},
): Record<string, BuildingRect> {
  const effectiveSeed = seed.length > 0 ? seed : "town";
  const active = PLOT_PRIORITY.slice(0, activeCount);
  const out: Record<string, BuildingRect> = {};
  const placed: Array<BuildingRect & { spriteW?: number; spriteH?: number }> = [];

  // Day-0 core trio — fixed cells regardless of seed.
  const homeCol = Math.floor((WORLD.COLS - 1) / 2);
  const homeRow = Math.floor((WORLD.ROWS - 1) / 2);
  const coreCells: Record<string, CellPos> = {
    home:    { col: homeCol,     row: homeRow },
    library: { col: homeCol - 1, row: homeRow },
    store:   { col: homeCol + 1, row: homeRow },
  };

  const cells = allCells();
  const usedKeys = new Set<string>();
  for (const key of Object.keys(coreCells)) {
    if (!active.includes(key)) continue;
    const cell = coreCells[key]!;
    const rect = cellToRect(cell, effectiveSeed + "::" + key, spriteDims[key]);
    out[key] = rect;
    placed.push(rect);
    usedKeys.add(cell.col + "," + cell.row);
  }

  // Behavioural unlocks — each plot picks its cell independently.
  // Candidate cells are tried in salted-hash order; the first one whose
  // effective rect clears every already-placed building's effective rect
  // wins. Uses padding=1 so buildings don't sit shoulder-to-shoulder.
  for (const plotKey of active) {
    if (plotKey in coreCells) continue;
    const dims = spriteDims[plotKey];
    const candidates = cells
      .filter((c) => !usedKeys.has(c.col + "," + c.row))
      .map((c) => ({
        cell: c,
        rank: hash32(
          effectiveSeed + "::plot::" + plotKey + "::" + c.col + "," + c.row,
        ),
      }))
      .sort((a, b) => a.rank - b.rank);
    if (candidates.length === 0) break;
    let picked: (BuildingRect & { spriteW?: number; spriteH?: number }) | null =
      null;
    for (const cand of candidates) {
      const rect = cellToRect(
        cand.cell,
        effectiveSeed + "::" + plotKey,
        dims,
      );
      const candEff = effectiveRect(rect);
      const collides = placed.some((p) => rectsOverlap(candEff, effectiveRect(p), 1));
      if (!collides) {
        picked = rect;
        break;
      }
    }
    // Last resort — take the first candidate even if it overlaps, so a
    // dense grid still returns *something* instead of dropping the
    // building. In practice this only fires when every cell collides,
    // which means the WORLD grid is undersized for the active plot set.
    if (!picked) {
      picked = cellToRect(
        candidates[0]!.cell,
        effectiveSeed + "::" + plotKey,
        dims,
      );
    }
    out[plotKey] = picked;
    placed.push(picked);
    usedKeys.add(picked.cell.col + "," + picked.cell.row);
  }

  return out;
}
