// /api/town — high-level read/write of the caller's town.
//
//   GET    /api/town                → { buildings, customPlots, npcs, version }
//   POST   /api/town { buildings, customPlots?, npcs? }
//                                   → { version, count }
//   DELETE /api/town?slug=<slug>    → { ok: true, slug }
//
// The CLI's `town clone` / `town deploy` go through here. /api/plot
// stays around as the raw-plot escape hatch for power users and the
// in-game renderer.
//
// On POST the server owns layout: it diffs the incoming buildings list
// against the persisted Plot and runs incremental add/remove/changeVariant
// ops. CustomPlots are merged onto the plot wholesale. NPCs replace the
// existing roster atomically.

import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveUser } from "@/lib/auth-bearer";
import { prisma } from "@/lib/db";
import { loadManifest } from "@/lib/manifest";
import { normalizePermissions } from "@/lib/npc-templates";
import { resolveTownForOwner } from "@/lib/resolve-town";
import {
  applyTownShape,
  getTownShape,
  type TownShape,
} from "@/lib/town-shape";
import { assertSafeSvg } from "@/lib/town-tools";
import { IncrementalError } from "@town/plot-gen";
import type { CustomPlot, Plot } from "@town/plot";
import { validatePlot } from "@town/plot";

const NpcSchema = z.object({
  buildingId: z.string().min(1),
  // Slot within the building. Empty string is the implicit first slot
  // (the legacy one-NPC-per-building case). The CLI defaults to "" when
  // an MDX frontmatter doesn't set it.
  slotId: z.string().default(""),
  name: z.string().min(1),
  description: z.string(),
  prompt: z.string(),
  id: z.string().optional(),
  // Tool capability grant — integrations, core tasks/memory, skills.
  // We don't shape this in zod because the normaliser in npc-templates
  // already silently drops unknown keys (preventing permission leaks
  // from typos), and duplicating the shape here would just create a
  // second place to update.
  permissions: z.unknown().optional(),
});

const BuildingSchema = z.object({
  id: z.string().min(1),
  plotKey: z.string().min(1),
  // Optional — the server falls back to the plot's first variant when
  // the caller doesn't pin one. Lets `town init` ship a default
  // town.json without knowing catalog variant ids ahead of time.
  variantId: z.string().min(1).optional(),
  // Optional sign text. Empty string clears any existing label.
  label: z.string().optional(),
  // Per-house group-chat opt-in. Absent = "no change" (preserve current
  // value); explicit true/false = patch. Mirrors PlotBuilding's flag.
  groupChatEnabled: z.boolean().optional(),
});

const CustomNpcPositionSchema = z.object({
  id: z.string().optional(),
  tx: z.number(),
  ty: z.number(),
  label: z.string(),
});

const CustomVariantSchema = z
  .object({
    id: z.string().min(1),
    exteriorSprite: z.string().min(1),
    // Actual sprite tile dimensions — used to keep tall sprites from
    // visually overlapping their neighbours on the overworld. Optional;
    // defaults to the footprint when absent.
    spriteW: z.number().int().positive().optional(),
    spriteH: z.number().int().positive().optional(),
    // Legacy single-position field — optional. New customPlots can
    // ship `npcPositions` alone; older CLI builds still send this.
    npcPosition: CustomNpcPositionSchema.optional(),
    npcPositions: z.array(CustomNpcPositionSchema).optional(),
  })
  .refine(
    (v) => Boolean(v.npcPosition) || (v.npcPositions && v.npcPositions.length > 0),
    {
      message: "variant must declare `npcPosition` or `npcPositions`",
      path: ["npcPosition"],
    },
  );

const CustomInteriorPropSchema = z.object({
  tx: z.number(),
  ty: z.number(),
  sprite: z.string(),
});

const TileRectSchema = z.object({
  tx: z.number(),
  ty: z.number(),
  w: z.number(),
  h: z.number(),
});

const TilePosSchema = z.object({
  tx: z.number(),
  ty: z.number(),
});

const CustomPlotSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  category: z.string(),
  interior: z.object({
    sprite: z.string().min(1),
    props: z.array(CustomInteriorPropSchema),
    widthTiles: z.number().int().positive(),
    heightTiles: z.number().int().positive(),
    walkable: TileRectSchema,
    extraWalkable: z.array(TileRectSchema).optional(),
    blocked: z.array(TileRectSchema).optional(),
    spawn: TilePosSchema,
    exit: TilePosSchema,
  }),
  variants: z.array(CustomVariantSchema).min(1),
});

// Per-town catalog uploaded by `town deploy`. Tags are tiny structured data
// (authored inline in town.json); items each carry an inlined SVG body
// (the CLI walks items/manifest.json + items/<id>.svg and bundles them).
// The whole catalog is stored as a single JSONB blob on the Town row.
const TownTagDefSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(40),
  emoji: z.string().min(1).max(8),
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "color must be a hex string"),
  defaultTtlSeconds: z.number().int().positive().nullable(),
  description: z.string().min(1).max(400),
});

const TownItemFieldSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "field name must be a JS identifier"),
  label: z.string().min(1).max(120),
  maxLength: z.number().int().positive().max(2000),
});

const TownItemBundleSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(60),
  description: z.string().min(1).max(400),
  fields: z.array(TownItemFieldSchema).max(20),
  // SVG body capped at 64KB — designer cards should be a couple KB each;
  // anything larger is almost certainly an authoring mistake (raster
  // payload embedded or runaway gradient).
  svg: z.string().min(20).max(64 * 1024),
});

const TownCatalogSchema = z.object({
  tags: z.array(TownTagDefSchema).max(64),
  items: z.array(TownItemBundleSchema).max(64),
});

const PostBodySchema = z.object({
  buildings: z.array(BuildingSchema).min(1),
  customPlots: z.array(CustomPlotSchema).optional(),
  npcs: z.array(NpcSchema).optional(),
  // Absent → leave the Town.catalogJson row alone (so a partial deploy
  // doesn't wipe the catalog). Present (even with empty arrays) → replace.
  catalog: TownCatalogSchema.optional(),
  // Owner's welcome pitch. Cap length so it fits comfortably in the
  // first-load dialogue without wrapping into a wall of text. Absent
  // → leave the stored description alone. Empty string → clear it.
  description: z.string().max(500).optional(),
});

export async function GET(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const r = await resolveTownForOwner(req, resolved.user.id);
  if (!r.ok) return NextResponse.json(r.body, { status: r.status });

  const { shape, version, npcs } = await getTownShape(r.townId);
  const town = await prisma.town.findUnique({
    where: { id: r.townId },
    select: { catalogJson: true },
  });
  return NextResponse.json({
    id: r.townId,
    buildings: shape.buildings,
    customPlots: shape.customPlots,
    npcs,
    version,
    ...(town?.catalogJson ? { catalog: town.catalogJson } : {}),
  });
}

export async function POST(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let parsed;
  try {
    parsed = PostBodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: "bad-request", detail: e instanceof Error ? e.message : "invalid body" },
      { status: 400 },
    );
  }

  // Catalog SVGs go through a stricter content check than Zod alone can
  // do. The CLI runs the same assertion at deploy, but anyone POSTing
  // a hand-crafted body directly could otherwise bypass it.
  if (parsed.catalog) {
    for (const it of parsed.catalog.items) {
      try {
        assertSafeSvg(it.id, it.svg);
      } catch (e) {
        return NextResponse.json(
          {
            error: "catalog-svg-unsafe",
            detail: e instanceof Error ? e.message : "unsafe svg",
          },
          { status: 400 },
        );
      }
    }
  }

  const r = await resolveTownForOwner(req, resolved.user.id);
  if (!r.ok) return NextResponse.json(r.body, { status: r.status });
  const townId = r.townId;

  const input: TownShape = {
    buildings: parsed.buildings,
    customPlots: (parsed.customPlots ?? []) as CustomPlot[],
  };

  // ?reflow=1 — drop the persisted plot before re-applying the shape.
  // This forces applyTownShape down the first-deploy path so each
  // building re-runs findFreeRect with the current cluster bias,
  // instead of keeping its original (pre-clustering) random cell.
  // Used by `town deploy --reflow` when a town's layout has drifted
  // wider than the postcard can frame.
  const url = new URL(req.url);
  if (url.searchParams.get("reflow") === "1") {
    await prisma.plotRow.delete({ where: { townId } }).catch(() => {
      // No row to drop — first deploy was about to happen anyway.
    });
  }

  // ?from=creator — the apply step for the AI town creator. We bracket
  // the deploy in a status flip so the live renderer can show a brief
  // "the owner is renovating" overlay on a per-town basis; the flip
  // back to "active" happens inside the same NPC transaction below so
  // a crashed apply leaves status="renovating" (visitor-visible cue
  // that the owner needs to retry) instead of a half-applied "active".
  const fromCreator = url.searchParams.get("from") === "creator";
  if (fromCreator) {
    await prisma.town.update({
      where: { id: townId },
      data: { status: "renovating" },
    });
  }

  let applied;
  try {
    applied = await applyTownShape(townId, input);
  } catch (e) {
    if (e instanceof IncrementalError) {
      return NextResponse.json(
        { error: "incremental-failed", code: e.code, detail: e.message },
        { status: 400 },
      );
    }
    throw e;
  }

  const check = validatePlot(applied.plot as Plot, loadManifest());
  if (!check.ok) {
    return NextResponse.json(
      { error: "validation-failed", issues: check.issues },
      { status: 400 },
    );
  }

  let npcCount = 0;
  try {
    const result = await prisma.$transaction(async (tx) => {
      let count = 0;
      if (parsed.npcs && parsed.npcs.length >= 0) {
        await tx.npc.deleteMany({ where: { townId } });
        if (parsed.npcs.length > 0) {
          const created = await tx.npc.createMany({
            data: parsed.npcs.map((n) => ({
              ...(n.id ? { id: n.id } : {}),
              townId,
              buildingId: n.buildingId,
              slotId: n.slotId,
              name: n.name,
              description: n.description,
              prompt: n.prompt,
              ...(n.permissions !== undefined
                ? {
                    permissions: normalizePermissions(
                      n.permissions,
                    ) as unknown as object,
                  }
                : {}),
            })),
          });
          count = created.count;
        }
      }
      if (parsed.catalog) {
        await tx.town.update({
          where: { id: townId },
          data: { catalogJson: parsed.catalog as unknown as object },
        });
      }
      if (parsed.description !== undefined) {
        // Empty string clears the description; any non-empty string
        // replaces it. Absent → leave the stored value alone.
        await tx.town.update({
          where: { id: townId },
          data: { description: parsed.description || null },
        });
      }
      // Flip back to active inside the same tx — a crashed apply leaves
      // status="renovating" so the next visitor sees the stale state.
      if (fromCreator) {
        await tx.town.update({
          where: { id: townId },
          data: { status: "active" },
        });
      }
      return count;
    });
    npcCount = result;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2025") {
      return NextResponse.json(
        {
          error: "no-town-row",
          detail:
            "Could not find the town. Did the slug resolve correctly?",
        },
        { status: 409 },
      );
    }
    throw e;
  }

  return NextResponse.json({
    version: applied.version,
    count: npcCount,
  });
}

// DELETE /api/town?slug=<slug>
//
// Hard-deletes the caller's town. The Prisma schema cascades the row
// into Aura, PlotRow, Npc, Conversation (+ ConversationParticipant /
// Message), PlotSuggestion, and CreatorConversation (which cascades to
// CreatorMessage). Sprite rows are user-scoped, so they survive — a
// re-created town under the same slug can reuse the user's sprite
// library without needing a re-upload.
export async function DELETE(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ error: "missing-slug" }, { status: 400 });
  }
  const town = await prisma.town.findUnique({ where: { slug } });
  if (!town) {
    return NextResponse.json({ error: "town-not-found" }, { status: 404 });
  }
  if (town.ownerId !== resolved.user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  await prisma.town.delete({ where: { id: town.id } });
  return NextResponse.json({ ok: true, slug });
}
