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
