export * from "./types";
export * from "./manifest";
export { validatePlot, type ValidationResult, type ValidationIssue } from "./validate";
export {
  isUploadedSpriteRef,
  uploadedSpriteHash,
  resolveSpriteUrl,
} from "./sprite";

// Pre-baked guest plot. Built by `@town/plot-gen`'s `build-default` script
// (seed="core", activeCount=6) and committed to ./default.json. The webapp
// imports this for the no-login fallback so guests see the same town every
// load without paying the cost of running the generator in the browser.
import defaultPlotJson from "./default.json";
import type { Plot } from "./types";
export const defaultPlot: Plot = defaultPlotJson as unknown as Plot;
