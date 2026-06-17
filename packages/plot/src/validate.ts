// Plot validation — proves every reference resolves against the catalog
// and the extras manifest. Run at write time (catalog HTML rendering,
// CLI `town deploy`, API write handlers).

import { getPlot as getCatalogPlot, getVariant } from "@town/catalog";
import type { Manifest } from "./manifest";
import type { CustomPlot, Plot, SpriteRef } from "./types";
import { customPlotId } from "./types";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** True for sprite refs that have already been uploaded to the server
 *  (e.g. "sprite:abc123..."). These are served from /api/sprites/<hash>.png. */
function isUploadedSpriteRef(ref: SpriteRef): boolean {
  return ref.startsWith("sprite:");
}

/** Validate a single sprite reference. The server accepts either an
 *  uploaded `sprite:<hash>` token or a catalog-relative path that resolves
 *  to an asset shipped in /sprites/catalog or /sprites/extras. Locally-
 *  scoped "./foo.png" refs aren't allowed here — the CLI must rewrite
 *  them to `sprite:<hash>` before deploy. */
function validateSpriteRef(ref: SpriteRef, path: string): ValidationIssue | null {
  if (!ref || typeof ref !== "string") {
    return { path, message: `sprite reference must be a non-empty string` };
  }
  if (isUploadedSpriteRef(ref)) {
    const hash = ref.slice("sprite:".length);
    if (!/^[a-f0-9]{8,128}$/.test(hash)) {
      return { path, message: `bad sprite hash in "${ref}"` };
    }
    return null;
  }
  if (ref.startsWith("./") || ref.startsWith("../") || ref.includes("..")) {
    return {
      path,
      message: `local sprite path "${ref}" — CLI must upload + rewrite before deploy`,
    };
  }
  if (ref.startsWith("/")) {
    return { path, message: `sprite refs must be relative, got "${ref}"` };
  }
  return null;
}

function validateCustomPlot(
  cp: CustomPlot,
  index: number,
  issues: ValidationIssue[],
): void {
  const prefix = `customPlots[${index}]`;
  if (!cp.id || typeof cp.id !== "string") {
    issues.push({ path: `${prefix}.id`, message: `missing id` });
    return;
  }
  if (cp.id.includes(":")) {
    issues.push({
      path: `${prefix}.id`,
      message: `id "${cp.id}" must not contain ":" (the "custom:" prefix is added automatically)`,
    });
  }
  if (!cp.interior || !Array.isArray(cp.interior.spriteCandidates)) {
    issues.push({ path: `${prefix}.interior`, message: `missing interior` });
    return;
  }
  if (cp.interior.spriteCandidates.length === 0) {
    issues.push({
      path: `${prefix}.interior.spriteCandidates`,
      message: `at least one interior sprite candidate required`,
    });
  }
  for (const [i, ref] of cp.interior.spriteCandidates.entries()) {
    const issue = validateSpriteRef(ref, `${prefix}.interior.spriteCandidates[${i}]`);
    if (issue) issues.push(issue);
  }
  for (const [i, prop] of cp.interior.props.entries()) {
    const issue = validateSpriteRef(prop.sprite, `${prefix}.interior.props[${i}].sprite`);
    if (issue) issues.push(issue);
  }
  if (!Array.isArray(cp.variants) || cp.variants.length === 0) {
    issues.push({ path: `${prefix}.variants`, message: `at least one variant required` });
    return;
  }
  const variantIds = new Set<string>();
  for (const [i, v] of cp.variants.entries()) {
    const vprefix = `${prefix}.variants[${i}]`;
    if (!v.id) {
      issues.push({ path: `${vprefix}.id`, message: `missing variant id` });
    } else if (variantIds.has(v.id)) {
      issues.push({ path: `${vprefix}.id`, message: `duplicate variant id "${v.id}"` });
    } else {
      variantIds.add(v.id);
    }
    if (!Array.isArray(v.exteriorSpriteCandidates) || v.exteriorSpriteCandidates.length === 0) {
      issues.push({
        path: `${vprefix}.exteriorSpriteCandidates`,
        message: `at least one exterior sprite candidate required`,
      });
    }
    for (const [j, ref] of (v.exteriorSpriteCandidates ?? []).entries()) {
      const issue = validateSpriteRef(ref, `${vprefix}.exteriorSpriteCandidates[${j}]`);
      if (issue) issues.push(issue);
    }
    // A variant must declare at least one NPC slot — via either the
    // legacy singular `npcPosition` or the new `npcPositions` array.
    const hasSingular = Boolean(v.npcPosition);
    const hasArray = Array.isArray(v.npcPositions) && v.npcPositions.length > 0;
    if (!hasSingular && !hasArray) {
      issues.push({
        path: `${vprefix}`,
        message: `at least one of \`npcPosition\` or \`npcPositions\` is required`,
      });
    }
    // Slot ids must be unique within a variant. The empty string is a
    // valid slot — it's the default that one-slot variants resolve to.
    if (Array.isArray(v.npcPositions)) {
      const slotIds = new Set<string>();
      for (const [j, pos] of v.npcPositions.entries()) {
        const sid = pos.id ?? "";
        if (slotIds.has(sid)) {
          issues.push({
            path: `${vprefix}.npcPositions[${j}].id`,
            message: `duplicate slot id "${sid}"`,
          });
        }
        slotIds.add(sid);
      }
    }
  }
}

export function validatePlot(plot: Plot, manifest: Manifest): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (plot.schemaVersion !== 1) {
    issues.push({ path: "schemaVersion", message: `unknown version ${plot.schemaVersion}` });
  }

  // Custom plots first, so building lookups can refer to them by id.
  const customById = new Map<string, CustomPlot>();
  for (const [i, cp] of (plot.customPlots ?? []).entries()) {
    validateCustomPlot(cp, i, issues);
    if (cp.id && !customById.has(cp.id)) customById.set(cp.id, cp);
    else if (cp.id) {
      issues.push({
        path: `customPlots[${i}].id`,
        message: `duplicate customPlot id "${cp.id}"`,
      });
    }
  }

  // Buildings
  const buildingIds = new Set<string>();
  for (const [i, b] of plot.buildings.entries()) {
    const prefix = `buildings[${i}]`;
    if (buildingIds.has(b.id)) {
      issues.push({ path: `${prefix}.id`, message: `duplicate building id "${b.id}"` });
    }
    buildingIds.add(b.id);

    const customId = customPlotId(b.plotKey);
    if (customId) {
      const cp = customById.get(customId);
      if (!cp) {
        issues.push({
          path: `${prefix}.plotKey`,
          message: `unknown custom plot "${b.plotKey}" — no matching customPlots entry`,
        });
        continue;
      }
      if (!cp.variants.some((v) => v.id === b.variantId)) {
        issues.push({
          path: `${prefix}.variantId`,
          message: `variantId "${b.variantId}" does not belong to custom plot "${b.plotKey}"`,
        });
      }
    } else {
      const catalogPlot = getCatalogPlot(b.plotKey.replace(/-\d+$/, ""));
      if (!catalogPlot) {
        issues.push({ path: `${prefix}.plotKey`, message: `unknown plotKey "${b.plotKey}"` });
        continue;
      }
      const variant = getVariant(b.variantId);
      if (!variant) {
        issues.push({ path: `${prefix}.variantId`, message: `unknown variantId "${b.variantId}"` });
        continue;
      }
      const matches = catalogPlot.variants.some((v) => v.id === b.variantId);
      if (!matches) {
        issues.push({
          path: `${prefix}.variantId`,
          message: `variantId "${b.variantId}" does not belong to plot "${b.plotKey}"`,
        });
      }
    }
    if (b.tx < 0 || b.ty < 0 || b.tx + b.w > plot.world.w || b.ty + b.h > plot.world.h) {
      issues.push({ path: `${prefix}`, message: `building extends past world bounds` });
    }
  }

  // Exactly one canonical HOME building, keyed by id "home". The system
  // Founder NPC + the runtime's CORE-workspace-name override both rely
  // on this — they only fire on the building with id === "home".
  const homeCount = plot.buildings.filter((b) => b.id === "home").length;
  if (homeCount === 0) {
    issues.push({
      path: "buildings",
      message: `town is missing its HOME building (must include one entry with id "home")`,
    });
  } else if (homeCount > 1) {
    issues.push({
      path: "buildings",
      message: `more than one building has id "home" — must be exactly one`,
    });
  }

  // Paths reference real buildings.
  for (const [i, p] of plot.paths.entries()) {
    if (!buildingIds.has(p.from)) {
      issues.push({ path: `paths[${i}].from`, message: `unknown buildingId "${p.from}"` });
    }
    if (!buildingIds.has(p.to)) {
      issues.push({ path: `paths[${i}].to`, message: `unknown buildingId "${p.to}"` });
    }
  }

  // Decor references real manifest entries.
  for (const [i, d] of plot.decor.entries()) {
    const group = (manifest as unknown as Record<string, { id: string }[]>)[d.group];
    if (!group) {
      issues.push({ path: `decor[${i}].group`, message: `unknown manifest group "${d.group}"` });
      continue;
    }
    if (!group.some((e) => e.id === d.spriteId)) {
      issues.push({
        path: `decor[${i}].spriteId`,
        message: `unknown sprite "${d.spriteId}" in group "${d.group}"`,
      });
    }
  }

  // NPCs reference real buildings. Each (buildingId, slotId) pair must
  // be unique — the renderer matches each plot.npcs entry to one Npc
  // row by that key, and a duplicate would silently collapse both.
  const npcSlotKeys = new Set<string>();
  for (const [i, n] of plot.npcs.entries()) {
    if (!buildingIds.has(n.buildingId)) {
      issues.push({ path: `npcs[${i}].buildingId`, message: `unknown buildingId "${n.buildingId}"` });
    }
    const slotKey = `${n.buildingId}::${n.slotId ?? ""}`;
    if (npcSlotKeys.has(slotKey)) {
      issues.push({
        path: `npcs[${i}]`,
        message: `duplicate slot "${n.slotId ?? ""}" on building "${n.buildingId}"`,
      });
    }
    npcSlotKeys.add(slotKey);
  }

  return { ok: issues.length === 0, issues };
}
