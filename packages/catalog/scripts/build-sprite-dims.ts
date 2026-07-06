// Scans every exterior PNG under apps/web/public/sprites/catalog/exteriors,
// reads its IHDR chunk to pick up the pixel width + height, and writes a
// map from catalog-relative sprite ref → tile dimensions to
// packages/catalog/src/sprite-dims.json.
//
// Layout math (see @town/plot-gen) uses these dims to reserve enough
// space around a building so tall / wide catalog sprites don't clip into
// neighbours. Custom plots ship their own spriteW/spriteH; catalog
// variants use this baked map so the same overlap-avoidance logic works
// end-to-end.
//
// Run from the repo root:
//   pnpm --filter @town/catalog build-sprite-dims
//
// Commit the output so downstream packages don't need node fs at import
// time (browser-safe consumption).

import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const exteriorsRoot = resolve(
  repoRoot,
  "apps/web/public/sprites/catalog/exteriors",
);

const TILE = 16;

/** Read a PNG's pixel width + height by parsing the IHDR chunk. */
function readPngDims(path: string): { widthPx: number; heightPx: number } {
  const buf = readFileSync(path);
  // 8-byte signature, then a 4-byte length, 4-byte "IHDR" tag, then
  // 4-byte width + 4-byte height (big-endian).
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { widthPx: width, heightPx: height };
}

function walkPngs(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    const s = statSync(p);
    if (s.isDirectory()) walkPngs(p, out);
    else if (s.isFile() && entry.endsWith(".png")) out.push(p);
  }
  return out;
}

const dims: Record<string, { tileW: number; tileH: number }> = {};
const pngs = walkPngs(exteriorsRoot).sort();
for (const abs of pngs) {
  const { widthPx, heightPx } = readPngDims(abs);
  if (widthPx % TILE !== 0 || heightPx % TILE !== 0) {
    console.warn(
      `[sprite-dims] ${abs} is ${widthPx}×${heightPx} px — not tile-aligned, ` +
      `rounding to (${Math.ceil(widthPx / TILE)}, ${Math.ceil(heightPx / TILE)})`,
    );
  }
  // Catalog-relative key mirrors what Variant.exteriorSprite ships:
  // "exteriors/<plot>/<sprite>.png".
  const rel = "exteriors/" + relative(exteriorsRoot, abs).split(/[\\/]/).join("/");
  dims[rel] = {
    tileW: Math.ceil(widthPx / TILE),
    tileH: Math.ceil(heightPx / TILE),
  };
}

const outPath = resolve(here, "..", "src", "sprite-dims.json");
writeFileSync(outPath, JSON.stringify(dims, null, 2) + "\n");

console.log(`built sprite-dims — ${Object.keys(dims).length} sprites`);
console.log(`  → ${outPath}`);
