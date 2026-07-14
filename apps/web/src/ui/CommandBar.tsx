"use client";

// Cmd+K command palette — reads the active plot's buildings and lets
// the player teleport to any of them. Shadcn-flavoured shell around
// `cmdk`: search input at the top, filtered list below, footer with
// keyboard hints. Selection dispatches to the overworld scene through
// the teleport bridge (see game/teleport.ts).

import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";

import { getCachedPlot } from "../game/plotClient";
import { getNpcs, onNpcsChange, type NpcRow } from "../game/npcs";
import { teleportTo } from "../game/teleport";
import { ui } from "./store";

interface BuildingEntry {
  id: string;
  label: string;
  residents: NpcRow[];         // NPCs that live in this building
  residentNames: string;       // display string ("Cosma, Linnea")
  residentSearchTerm: string;  // lowercased for cmdk's filter value
}

// Title-case a building id like "gilded-fox" → "Gilded Fox". Only used
// as a fallback when the plot doesn't ship an explicit label.
function titleCase(id: string): string {
  return id
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function buildingLabel(id: string, raw: string | undefined): string {
  if (raw && raw.trim()) return raw;
  return titleCase(id);
}

export function CommandBar() {
  const [query, setQuery] = useState("");
  // Snapshot NPCs once at mount and re-tick when the module cache
  // resolves — the palette is short-lived, but the NPC roster arrives
  // asynchronously and might not be there yet when Cmd+K is first hit.
  const [npcTick, setNpcTick] = useState(0);
  useEffect(() => {
    const off = onNpcsChange(() => setNpcTick((t) => t + 1));
    return off;
  }, []);

  const buildings = useMemo<BuildingEntry[]>(() => {
    const plot = getCachedPlot();
    if (!plot) return [];
    // Group the flat NPC list by buildingId so each row can render its
    // residents inline. We depend on `npcTick` so the memo recomputes
    // when the roster loads.
    void npcTick;
    const byBuilding = new Map<string, NpcRow[]>();
    for (const npc of getNpcs()) {
      const bucket = byBuilding.get(npc.buildingId);
      if (bucket) bucket.push(npc);
      else byBuilding.set(npc.buildingId, [npc]);
    }
    return plot.buildings.map((b) => {
      const residents = byBuilding.get(b.id) ?? [];
      const residentNames = residents.map((n) => n.name).join(", ");
      return {
        id: b.id,
        label: buildingLabel(b.id, b.label),
        residents,
        residentNames,
        residentSearchTerm: residentNames.toLowerCase(),
      };
    });
  }, [npcTick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        ui.closeCommandBar();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  function onSelect(buildingId: string) {
    ui.closeCommandBar();
    teleportTo(buildingId);
  }

  return (
    <div
      className="fixed inset-0 z-[65] flex items-start justify-center bg-black/70 p-6 pt-[15vh] backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) ui.closeCommandBar();
      }}
    >
      <div
        className="w-full max-w-lg overflow-hidden border-2 bg-[#0e1116] text-paper shadow-[3px_3px_0_0_rgba(0,0,0,0.45)]"
        style={{ borderColor: "rgba(246, 243, 234, 0.14)" }}
      >
        <Command
          label="Teleport to a building"
          shouldFilter
          loop
          className="flex flex-col"
        >
          <div
            className="flex items-center gap-2 border-b-2 px-3"
            style={{ borderColor: "rgba(246, 243, 234, 0.1)" }}
          >
            <SearchIcon />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              autoFocus
              placeholder="Teleport to…"
              className="flex-1 bg-transparent px-1 py-3 text-sm text-paper placeholder:text-paper/40 focus:outline-none"
            />
            <kbd className="hidden sm:inline-flex h-5 items-center border border-paper/25 bg-paper/[0.06] px-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-paper/70">
              ESC
            </kbd>
          </div>

          <Command.List className="max-h-[50vh] overflow-y-auto p-1">
            <Command.Empty className="px-3 py-6 text-center text-xs uppercase tracking-widest text-paper/50">
              No buildings match.
            </Command.Empty>

            <Command.Group
              heading="Buildings"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.2em] [&_[cmdk-group-heading]]:text-paper/40"
            >
              {buildings.map((b) => (
                <Command.Item
                  key={b.id}
                  // cmdk filters against the `value` string. Folding
                  // the resident names in here means typing an NPC's
                  // name lands you on the building they live in.
                  value={`${b.label} ${b.id} ${b.residentSearchTerm}`}
                  onSelect={() => onSelect(b.id)}
                  className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-paper/85 aria-selected:bg-paper/[0.08] aria-selected:text-paper"
                >
                  <span className="flex flex-col gap-0.5 truncate">
                    <span className="truncate font-medium">{b.label}</span>
                    <span className="truncate text-[10px] tracking-[0.02em] text-paper/45">
                      {b.residents.length > 0
                        ? b.residentNames
                        : "no residents yet"}
                    </span>
                  </span>
                  <span className="text-[10px] uppercase tracking-widest text-paper/40">
                    Teleport →
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>

          <div
            className="flex items-center justify-between gap-3 border-t-2 px-3 py-2 text-[10px] uppercase tracking-widest text-paper/45"
            style={{ borderColor: "rgba(246, 243, 234, 0.1)" }}
          >
            <span className="flex items-center gap-1.5">
              <kbd className="inline-flex h-4 items-center border border-paper/25 bg-paper/[0.06] px-1 font-mono text-[10px] tracking-wider text-paper/70">
                ↑↓
              </kbd>
              navigate
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="inline-flex h-4 items-center border border-paper/25 bg-paper/[0.06] px-1 font-mono text-[10px] tracking-wider text-paper/70">
                ↵
              </kbd>
              teleport
            </span>
          </div>
        </Command>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      className="shrink-0 text-paper/45"
      aria-hidden
    >
      <circle cx={11} cy={11} r={7} stroke="currentColor" strokeWidth={2} />
      <path
        d="M20 20l-3.5-3.5"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="square"
      />
    </svg>
  );
}
