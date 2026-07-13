import type { StampShape } from "./types";

const PALETTE: Array<{ color: string; glyph: string }> = [
  { color: "#4a7f3f", glyph: "◆" },
  { color: "#8b3030", glyph: "✕" },
  { color: "#3a6ea5", glyph: "▲" },
  { color: "#c46b1e", glyph: "✦" },
  { color: "#5a4d8a", glyph: "◆" },
  { color: "#2f6e6a", glyph: "●" },
  { color: "#8a5a1e", glyph: "★" },
  { color: "#7a2e6a", glyph: "✿" },
];

const SHAPES: StampShape[] = ["circle", "circle", "circle", "rect", "circle", "circle"];

export function hashSlug(slug: string): number {
  let hash = 5381;
  for (let i = 0; i < slug.length; i++) {
    hash = ((hash << 5) + hash + slug.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function paletteForSlug(slug: string): { color: string; glyph: string; shape: StampShape } {
  const h = hashSlug(slug);
  const entry = PALETTE[h % PALETTE.length]!;
  const shape = SHAPES[(h >>> 3) % SHAPES.length]!;
  return { ...entry, shape };
}

export function tiltFor(slug: string, seed: number): number {
  const h = hashSlug(`${slug}:${seed}`);
  return (h % 21) - 10;
}
