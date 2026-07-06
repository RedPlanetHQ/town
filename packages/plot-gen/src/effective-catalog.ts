// Effective catalog — unified lookup over `@town/catalog` and any
// `Plot.customPlots` entries the user supplied. Every plot-gen consumer
// that needs to resolve a plotKey → (plot, variant) goes through here so
// the incremental ops behave identically for catalog buildings and
// user-defined ones.
//
// Custom plot keys are encoded as `"custom:<id>"` (see
// `@town/plot`'s `CUSTOM_PLOT_PREFIX`). All other keys fall through to
// `@town/catalog`'s `getPlot` after stripping the instance suffix.

import type { Catalog, Category } from "@town/catalog";
import { getSpriteDims } from "@town/catalog";
import type { CustomPlot } from "@town/plot";
import { customPlotId } from "@town/plot";
import { baseKey } from "./world";

/** Catalog-shape projection of a CustomPlot variant so callers can treat
 *  catalog + custom uniformly. Only the fields plot-gen consumes. */
export interface EffectiveNpcSlot {
  id: string;
  tx: number;
  ty: number;
  label: string;
}

export interface EffectiveVariant {
  id: string;
  exteriorSprite: string;
  /** Actual sprite tile dimensions when the variant ships its own
   *  (customPlots only — catalog variants get these from the extras
   *  manifest via plot-gen's `manifestBuildingDims`). Used to reserve
   *  vertical space for tall sprites during placement. */
  spriteW?: number;
  spriteH?: number;
  /** Every NPC slot the variant supports, in canonical order. The CLI
   *  binds an MDX file's `slotId` to the matching entry's `id`. */
  npcSlots: EffectiveNpcSlot[];
}

export interface EffectivePlot {
  id: string;
  category: Category;
  variants: EffectiveVariant[];
}

function projectSlots(
  positions: Array<{ id?: string; tx: number; ty: number; label: string }> | undefined,
  fallback: { tx: number; ty: number; label: string } | undefined,
): EffectiveNpcSlot[] {
  // `npcPositions` is the source of truth when present. Otherwise fall
  // back to the legacy single-position field, treating it as slot "".
  // Validation (`@town/plot`) guarantees at least one source.
  const source = positions && positions.length > 0
    ? positions
    : fallback
      ? [{ ...fallback }]
      : [];
  const seen = new Set<string>();
  const out: EffectiveNpcSlot[] = [];
  for (const pos of source) {
    let id = pos.id ?? "";
    // Dedupe — keep the first slot for any colliding id.
    while (seen.has(id)) id += "_";
    seen.add(id);
    out.push({ id, tx: pos.tx, ty: pos.ty, label: pos.label });
  }
  return out;
}

/** Resolve a plotKey to its effective plot definition. Returns null if
 *  the key doesn't match anything in catalog or customPlots. */
export function resolveEffectivePlot(
  catalog: Catalog,
  customPlots: CustomPlot[],
  plotKey: string,
): EffectivePlot | null {
  const customId = customPlotId(plotKey);
  if (customId) {
    const cp = customPlots.find((c) => c.id === customId);
    if (!cp) return null;
    return {
      id: `custom:${cp.id}`,
      category: cp.category,
      variants: cp.variants.map((v) => ({
        id: v.id,
        exteriorSprite: v.exteriorSprite,
        ...(v.spriteW !== undefined ? { spriteW: v.spriteW } : {}),
        ...(v.spriteH !== undefined ? { spriteH: v.spriteH } : {}),
        npcSlots: projectSlots(v.npcPositions, v.npcPosition),
      })),
    };
  }
  const cp = catalog.plots.find((p) => p.id === baseKey(plotKey));
  if (!cp) return null;
  return {
    id: cp.id,
    category: cp.category,
    variants: cp.variants.map((v) => {
      // Fill in tile dimensions from the baked catalog sprite-dims map so
      // downstream placement (findFreeRect / effectiveRect) sees the real
      // footprint instead of the 10×7 fallback. Custom plots ship dims
      // on their variants directly; catalog variants don't, so we look
      // them up here.
      const dims = getSpriteDims(v.exteriorSprite);
      return {
        id: v.id,
        exteriorSprite: v.exteriorSprite,
        ...(dims ? { spriteW: dims.tileW, spriteH: dims.tileH } : {}),
        npcSlots: projectSlots(v.npcPositions, v.npcPosition),
      };
    }),
  };
}

/** Pick a variant by id, falling back to the first one defined. */
export function pickVariant(
  plot: EffectivePlot,
  variantId?: string,
): EffectiveVariant | null {
  if (variantId) {
    const exact = plot.variants.find((v) => v.id === variantId);
    if (exact) return exact;
  }
  return plot.variants[0] ?? null;
}
