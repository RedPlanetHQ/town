// Creator-chat read tools.
//
// Each helper returns an AI SDK `Tool` ready to be plugged into
// `streamText({ tools: { ... } })`. Read tools are pure — they look up
// the current town state, the global catalog, or the pending diff queue.
// They never mutate anything (mutation tools live in ./mutation-tools.ts)
// so the model can call them aggressively while exploring.
//
// The catalog is a `{ plots: Plot[] }` shape — see packages/catalog/src/types.ts.
// We expose a flat ({ key, label, category }) view to the model because
// "categories" + "plotKeys" are how the user thinks about buildings, and
// the model picks the right plotKey before it ever calls `add_building`.
//
// `npcPositions` superseded `npcPosition` in the catalog — we surface the
// union so the model can see every slot a variant offers without the
// legacy / new fork leaking into the tool result.

import { tool } from "ai";
import { z } from "zod";
import { catalog } from "@town/catalog";
import type { PrismaClient } from "@town/db";

export type ToolContext = {
  townId: string;
  conversationId: string;
  userId: string;
  prisma: PrismaClient;
};

export const getCurrentTownTool = (ctx: ToolContext) =>
  tool({
    description:
      "Get the current state of the town being edited (buildings + NPCs + aura) and this conversation's pending diff.",
    inputSchema: z.object({}),
    execute: async () => {
      const [town, aura, plot, npcs, changes] = await Promise.all([
        ctx.prisma.town.findUnique({
          where: { id: ctx.townId },
          select: { id: true, slug: true, name: true, status: true },
        }),
        ctx.prisma.aura.findUnique({ where: { townId: ctx.townId } }),
        ctx.prisma.plotRow.findUnique({ where: { townId: ctx.townId } }),
        ctx.prisma.npc.findMany({
          where: { townId: ctx.townId },
          select: {
            id: true,
            buildingId: true,
            slotId: true,
            name: true,
            description: true,
          },
        }),
        ctx.prisma.creatorChange.findMany({
          where: { conversationId: ctx.conversationId },
          orderBy: { createdAt: "asc" },
        }),
      ]);
      // PlotRow.json is the persisted Plot blob; we only surface
      // building-level fields the model needs to reason about edits.
      const plotJson = plot?.json as
        | {
            buildings?: Array<{
              id: string;
              plotKey: string;
              variantId?: string;
              label?: string;
            }>;
          }
        | undefined;
      return {
        town: town
          ? {
              ...town,
              aura: { current: aura?.current ?? 1000, max: aura?.max ?? 1000 },
            }
          : null,
        buildings: (plotJson?.buildings ?? []).map((b) => ({
          id: b.id,
          plotKey: b.plotKey,
          variantId: b.variantId,
          label: b.label,
        })),
        npcs,
        pendingChanges: changes.map((c) => ({
          id: c.id,
          kind: c.kind,
          payload: c.payload,
          summary: c.summary,
        })),
      };
    },
  });

export const listCategoriesTool = () =>
  tool({
    description:
      "List the high-level building categories in the global catalog (HOME, WORK, READ, etc.).",
    inputSchema: z.object({}),
    execute: async () => {
      const cats = Array.from(new Set(catalog.plots.map((p) => p.category)));
      return { categories: cats.sort() };
    },
  });

export const listPlotkeysTool = () =>
  tool({
    description:
      "List plot keys (building templates) in a category. Returns id + label only — call get_plotkey_details for variants and NPC slots.",
    inputSchema: z.object({
      category: z.string().optional(),
    }),
    execute: async ({ category }) => {
      const entries = catalog.plots.filter(
        (p) => !category || p.category === category,
      );
      return {
        plotKeys: entries.map((p) => ({
          key: p.id,
          label: p.label,
          category: p.category,
        })),
      };
    },
  });

export const getPlotkeyDetailsTool = () =>
  tool({
    description:
      "Get full details for a single plotKey: category, every variant + exteriorSprite, and NPC slot positions per variant.",
    inputSchema: z.object({ key: z.string() }),
    execute: async ({ key }) => {
      const def = catalog.plots.find((p) => p.id === key);
      if (!def) return { error: "not-found", key };
      return {
        key,
        label: def.label,
        category: def.category,
        variants: def.variants.map((v) => ({
          id: v.id,
          canonical: v.canonical,
          profession: v.profession,
          vibe: v.vibe,
          exteriorSprite: v.exteriorSprite,
          // Both shapes coexist in the catalog — legacy variants ship a
          // single `npcPosition`, newer ones ship `npcPositions`. We
          // collapse to a single normalized list so the model only ever
          // sees one slot shape.
          npcSlots:
            v.npcPositions?.map((s) => ({
              id: s.id ?? "",
              label: s.label,
              tx: s.tx,
              ty: s.ty,
            })) ??
            (v.npcPosition
              ? [
                  {
                    id: v.npcPosition.id ?? "",
                    label: v.npcPosition.label,
                    tx: v.npcPosition.tx,
                    ty: v.npcPosition.ty,
                  },
                ]
              : []),
        })),
      };
    },
  });
