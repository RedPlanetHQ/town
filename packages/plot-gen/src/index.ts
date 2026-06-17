export { generatePlot, type GenerateInput } from "./generate";
export { generateLayout, type BuildingRect, type CellPos } from "./layout";
export { roadTiles } from "./roads";
export { scatterDecor } from "./decor";
export { placePonds } from "./ponds";
export { clearingRadiusAt, inAnyClearing, inAnyBuilding } from "./clearings";
export { hash32, shuffle } from "./rng";
export { WORLD, PLOT_PRIORITY, baseKey } from "./world";
export {
  resolveEffectivePlot,
  pickVariant,
  type EffectivePlot,
  type EffectiveVariant,
} from "./effective-catalog";
export {
  addBuilding,
  removeBuilding,
  changeVariant,
  diffBuildings,
  applyBuildingDiff,
  IncrementalError,
  type IncrementalCtx,
  type AddBuildingInput,
  type AddBuildingResult,
  type RemoveBuildingInput,
  type ChangeVariantInput,
  type BuildingSpec,
  type BuildingDiff,
} from "./incremental";
