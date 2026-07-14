// Town persistence helpers.
//
// A town-next user can own N towns. Identity is keyed on
// (coreUserId, workspaceId); Town.ownerId is no longer unique.
// Every Town has a 1:1 Aura row created in the same transaction
// as the Town.

import { catalog } from "@town/catalog";
import { generatePlot } from "@town/plot-gen";
import type { Manifest, Plot } from "@town/plot";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { prisma } from "./db";
import { OWNER_DEFAULT_CHARACTER } from "./characters";
import { seedNpcs } from "./plot";
import {
  generateShareCode,
  isValidSlug,
  normalizeSlug,
} from "./town-code";

let cachedManifest: Manifest | null = null;
function getManifest(): Manifest {
  if (cachedManifest) return cachedManifest;
  const path = resolve(
    process.cwd(),
    "public",
    "sprites",
    "extras",
    "MANIFEST.json",
  );
  cachedManifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  return cachedManifest;
}

function bootstrapPlot(townId: string): Plot {
  return generatePlot({
    seed: townId,
    catalog,
    manifest: getManifest(),
    activeCount: 3,
    id: `plot-${townId}`,
  });
}

export type PickTownInput = {
  ownerId: string;
  name: string;
  slug?: string;
};

export type TownRow = Awaited<ReturnType<typeof getTownBySlug>>;

export async function getTownsByOwner(ownerId: string) {
  return prisma.town.findMany({
    where: { ownerId },
    include: { aura: true },
    orderBy: { updatedAt: "desc" },
  });
}

export async function getTownBySlug(slug: string) {
  return prisma.town.findUnique({
    where: { slug },
    include: { aura: true },
  });
}

export async function getActiveTownForUser(
  ownerId: string,
  cookieSlug: string | null,
) {
  if (cookieSlug) {
    const byCookie = await prisma.town.findFirst({
      where: { slug: cookieSlug, ownerId },
      include: { aura: true },
    });
    if (byCookie) return byCookie;
  }
  return prisma.town.findFirst({
    where: { ownerId },
    include: { aura: true },
    orderBy: { updatedAt: "desc" },
  });
}

export async function pickTown({ ownerId, name, slug: explicitSlug }: PickTownInput) {
  const slug = normalizeSlug(explicitSlug ?? name);
  if (!isValidSlug(slug)) {
    const err = new Error("slug-invalid") as Error & { code: string };
    err.code = "slug-invalid";
    throw err;
  }

  // Cap gate — count the owner's existing towns against their per-account
  // limit. `User.maxTowns` seeds to the free-tier default (3) via the
  // schema; purchases / tier upgrades / milestones will mutate it in
  // place when the grant flow lands.
  const owner = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { maxTowns: true },
  });
  if (!owner) {
    const err = new Error("owner-missing") as Error & { code: string };
    err.code = "owner-missing";
    throw err;
  }
  const existing = await prisma.town.count({ where: { ownerId } });
  if (existing >= owner.maxTowns) {
    const err = new Error("town-limit-reached") as Error & {
      code: string;
      limit: number;
    };
    err.code = "town-limit-reached";
    err.limit = owner.maxTowns;
    throw err;
  }

  let town: Awaited<ReturnType<typeof prisma.town.create>> | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const shareCode = generateShareCode();
    try {
      town = await prisma.$transaction(async (tx) => {
        const created = await tx.town.create({
          data: { slug, name: name.trim(), ownerId, shareCode },
        });
        await tx.aura.create({ data: { townId: created.id } });
        const plot = bootstrapPlot(created.id);
        await tx.plotRow.create({
          data: {
            townId: created.id,
            json: plot as unknown as object,
            version: 1,
          },
        });
        return created;
      });
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "P2002") {
        const meta = (e as { meta?: { target?: string[] } }).meta;
        const target = meta?.target ?? [];
        if (target.includes("slug")) {
          const err = new Error("slug-taken") as Error & { code: string };
          err.code = "slug-taken";
          throw err;
        }
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  if (!town) throw lastError ?? new Error("town-create-failed");

  // Seed default NPCs against the freshly-built plot (idempotent).
  const plotRow = await prisma.plotRow.findUnique({ where: { townId: town.id } });
  if (plotRow) {
    await seedNpcs(town.id, plotRow.json as unknown as Plot);
  }

  // Default sprite for new owners (no clobber if they already picked one).
  await prisma.user.updateMany({
    where: { id: ownerId, character: null },
    data: { character: OWNER_DEFAULT_CHARACTER },
  });

  return town;
}

/**
 * Auto-create a town for a fresh user the first time they sign in.
 * Idempotent — no-op if the user already owns any town.
 *
 * Returns `true` if a town was actually created this call, so callers
 * (e.g. the OAuth callback) can decide whether to route the user to
 * their new dashboard instead of the referrer.
 *
 * Slug picking: starts from the user's name; on `slug-taken` retries
 * with `<slug>-<short-random>` a few times before giving up. If we
 * can't land a free slug we don't throw — the user just lands on
 * dashboard with zero towns and the "create town" CTA visible.
 */
export async function ensureFirstTown(
  ownerId: string,
  ownerName: string,
): Promise<boolean> {
  const existing = await prisma.town.count({ where: { ownerId } });
  if (existing > 0) return false;

  const baseSlug = normalizeSlug(ownerName) || "town";
  const townName = ownerName?.trim() ? `${ownerName.trim()}'s town` : "My town";
  const candidates = [
    baseSlug,
    `${baseSlug}-${randomSuffix(4)}`,
    `${baseSlug}-${randomSuffix(6)}`,
  ];

  for (const slug of candidates) {
    if (!isValidSlug(slug)) continue;
    try {
      await pickTown({ ownerId, name: townName, slug });
      return true;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "slug-taken") continue;
      if (code === "town-limit-reached") return false;
      console.warn("[first-town] create failed", e);
      return false;
    }
  }
  console.warn("[first-town] exhausted slug candidates for", ownerId);
  return false;
}

function randomSuffix(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)]!;
  }
  return out;
}

export async function rotateShareCode(townId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const shareCode = generateShareCode();
    try {
      return await prisma.town.update({
        where: { id: townId },
        data: { shareCode },
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "P2002") continue;
      throw e;
    }
  }
  throw new Error("rotate-share-code-failed");
}
