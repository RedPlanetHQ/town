// NPC chat-data cache.
//
// The interior scene reads NPC *slot* positions from plot.json
// (plot.npcs[]), and NPC *chat data* (name, description, prompt) from the
// per-user `Npc` table behind /api/npcs. This module holds a single
// process-wide snapshot of that DB roster so the renderer can look up a
// row synchronously by `buildingId` while building the SPACE prompt and
// greeting dialogue.
//
// Owner mode hits `/api/npcs`; visitor mode passes `?town=<slug>` so the
// server returns the resident's roster (gated by the visitor cookie).

import { getActiveTownSlug } from "./plotClient";

export type NpcRow = {
  id: string;
  buildingId: string;
  slotId: string;
  name: string;
  description: string;
  prompt: string;
};

// Each building can host one NPC per slot — see @town/catalog's
// `Variant.npcPositions`. Renderer reads everything by buildingId and
// matches each plot.npcs[] slot to the row with the same slotId.
let byBuildingId: Map<string, NpcRow[]> = new Map();
let inFlight: Promise<void> | null = null;
let listeners: Array<() => void> = [];

export function getNpcByBuildingAndSlot(
  buildingId: string,
  slotId: string,
): NpcRow | null {
  const rows = byBuildingId.get(buildingId);
  if (!rows) return null;
  return rows.find((r) => r.slotId === slotId) ?? null;
}

/** Legacy lookup — returns the first NPC for the building. Prefer
 *  `getNpcByBuildingAndSlot` for multi-slot variants. */
export function getNpcByBuildingId(buildingId: string): NpcRow | null {
  const rows = byBuildingId.get(buildingId);
  return rows && rows.length > 0 ? rows[0]! : null;
}

export function onNpcsChange(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((x) => x !== fn);
  };
}

/** Total NPC rows in the cache — the sum across every building. Used by
 *  the top-right population badge so visitors see "town has N residents
 *  + you" even when nobody else is currently roaming. */
export function getNpcCount(): number {
  let total = 0;
  for (const rows of byBuildingId.values()) total += rows.length;
  return total;
}

/** Flat list of every NPC in the cache. Used by the population popover
 *  to render an NPC directory with name + building + description. */
export function getNpcs(): NpcRow[] {
  const out: NpcRow[] = [];
  for (const rows of byBuildingId.values()) {
    for (const r of rows) out.push(r);
  }
  return out;
}

function emit() {
  for (const fn of listeners) fn();
}

export async function refreshNpcs(): Promise<void> {
  if (inFlight) return inFlight;
  // PopulationBadge defensively calls refreshNpcs() on its own mount —
  // but in React, child effects run BEFORE parent effects, so this can
  // fire before TownGame's boot effect has set the active slug. With
  // no slug we'd hit /api/npcs without a query, which:
  //   • 401s for guest visitors (no session, no slug to gate by
  //     cookie),
  //   • returns the wrong town's roster for multi-town owners.
  // Both are wrong outcomes. We treat "no slug yet" as "wait for
  // startNpcsSync to retry after setViewer/Owner TownSlug runs", and
  // return without touching the cache so an empty fetch doesn't wipe
  // a previously-loaded set.
  const slug = getActiveTownSlug();
  if (!slug) return;
  const url = `/api/npcs?town=${encodeURIComponent(slug)}`;
  inFlight = (async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        byBuildingId = new Map();
      } else {
        const body = (await res.json()) as {
          npcs?: Array<Omit<NpcRow, "slotId"> & { slotId?: string }>;
        };
        const next = new Map<string, NpcRow[]>();
        for (const n of body.npcs ?? []) {
          const row: NpcRow = { ...n, slotId: n.slotId ?? "" };
          const list = next.get(row.buildingId);
          if (list) list.push(row);
          else next.set(row.buildingId, [row]);
        }
        byBuildingId = next;
      }
    } catch {
      byBuildingId = new Map();
    } finally {
      inFlight = null;
    }
    emit();
  })();
  return inFlight;
}

/** Kick off one fetch on mount. Returns a teardown so the host component
 *  can clear the cache when the page is torn down. */
export function startNpcsSync(): () => void {
  if (typeof window === "undefined") return () => {};
  void refreshNpcs();
  return () => {
    byBuildingId = new Map();
    listeners = [];
  };
}
