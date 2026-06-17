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
import type { CustomPlot } from "@town/plot";
import { customPlotId } from "@town/plot";
import { baseKey } from "./world";

/** Catalog-shape projection of a CustomPlot variant so callers can treat
 *  catalog + custom uniformly. Only the fields plot-gen consumes. */
export interface EffectiveVariant {
  id: string;
  exteriorSpriteCandidates: string[];
  npcPosition: { tx: number; ty: number; label: string };
}

export interface EffectivePlot {
  id: string;
  category: Category;
  variants: EffectiveVariant[];
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
        exteriorSpriteCandidates: v.exteriorSpriteCandidates,
        npcPosition: v.npcPosition,
      })),
    };
  }
  const cp = catalog.plots.find((p) => p.id === baseKey(plotKey));
  if (!cp) return null;
  return {
    id: cp.id,
    category: cp.category,
    variants: cp.variants.map((v) => ({
      id: v.id,
      exteriorSpriteCandidates: v.exteriorSpriteCandidates,
      npcPosition: v.npcPosition,
    })),
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
