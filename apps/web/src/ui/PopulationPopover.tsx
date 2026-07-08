"use client";

// Popover anchored under the Population HudButton. Two sections:
//   • NPCs — name, building label, short description.
//   • Guests — name, character avatar.
//
// Single search input filters both sections by name (case-insensitive
// substring). The list scrolls after ~10 rows so the popover height
// stays predictable regardless of how busy the town is.

import { useEffect, useMemo, useRef, useState } from "react";

import { getCachedPlot } from "../game/plotClient";
import { getNpcs, onNpcsChange, type NpcRow } from "../game/npcs";
import {
  getRemotePlayers,
  onRemotesChange,
  type RemotePlayer,
} from "../game/realtime";
import { AuraBar } from "./AuraBar";
import { CharacterAvatar } from "./CharacterAvatar";

export interface Aura {
  current: number;
  max: number;
}

interface PopulationPopoverProps {
  /** Aura snapshot fetched by the parent badge — passed in so we don't
   *  fire a second request when the popover opens. Null when the town
   *  doesn't have a slug (the unsigned-root playground). */
  aura: Aura | null;
  /** Close the popover. Bound to outside-click + Esc + the X button. */
  onClose: () => void;
}

export function PopulationPopover({ aura, onClose }: PopulationPopoverProps) {
  const [query, setQuery] = useState("");
  const [npcs, setNpcs] = useState<NpcRow[]>(() => getNpcs());
  const [remotes, setRemotes] = useState<RemotePlayer[]>(() => getRemotePlayers());
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Subscribe to live updates so the popover reflects new arrivals
  // without needing to be reopened.
  useEffect(() => {
    setNpcs(getNpcs());
    return onNpcsChange(() => setNpcs(getNpcs()));
  }, []);
  useEffect(() => {
    setRemotes(getRemotePlayers());
    return onRemotesChange(() => setRemotes(getRemotePlayers()));
  }, []);

  // Esc + outside click close the popover. Same UX as IdentityMenu.
  useEffect(() => {
    function onPointer(e: PointerEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Focus the search input on open so typing-to-filter just works.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Map buildingId → label off the cached plot. NPCs only carry
  // buildingId, but the popover wants the human label ("Office",
  // "Library", …). Falls back to the bare id when the plot hasn't
  // landed yet.
  const buildingLabelById = useMemo(() => {
    const map = new Map<string, string>();
    const plot = getCachedPlot();
    if (plot) {
      for (const b of plot.buildings) {
        if (b.label) map.set(b.id, b.label);
      }
    }
    return map;
  }, []);

  const filteredNpcs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return npcs;
    return npcs.filter((n) => n.name.toLowerCase().includes(q));
  }, [npcs, query]);

  const filteredGuests = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return remotes;
    return remotes.filter((r) => r.name.toLowerCase().includes(q));
  }, [remotes, query]);

  return (
    <div
      ref={rootRef}
      className="nb-card-dark absolute right-0 z-40 mt-2 flex flex-col"
      style={{ top: "100%", width: 320, height: 440, maxHeight: "70vh" }}
      role="dialog"
      aria-label="Population directory"
    >
      <div className="flex items-center justify-between gap-2 border-b-2 border-paper/15 px-3 py-2">
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-paper">
          <span>Population</span>
          {aura ? (
            <>
              <span aria-hidden className="text-paper/30">·</span>
              <AuraBar current={aura.current} max={aura.max} width={48} />
              <span className="font-mono normal-case tracking-normal text-paper">
                {aura.current}
                <span className="text-paper/40">/{aura.max}</span>
              </span>
            </>
          ) : null}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close population panel"
          className="inline-flex h-6 w-6 items-center justify-center text-base font-bold leading-none text-paper/70 hover:bg-white/10 hover:text-paper"
        >
          ×
        </button>
      </div>

      <div className="border-b-2 border-paper/15 px-3 py-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name"
          className="w-full border-2 border-paper/20 bg-black/30 px-2 py-1 text-xs text-paper placeholder:text-paper/40 focus:border-paper/50 focus:outline-none"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <Section title={`NPCs (${filteredNpcs.length})`}>
          {filteredNpcs.length === 0 ? (
            <EmptyRow>No NPCs match.</EmptyRow>
          ) : (
            filteredNpcs.map((n) => (
              <NpcItem
                key={n.id}
                npc={n}
                buildingLabel={
                  buildingLabelById.get(n.buildingId) ?? n.buildingId
                }
              />
            ))
          )}
        </Section>

        <Section title={`Guests (${filteredGuests.length})`}>
          {filteredGuests.length === 0 ? (
            <EmptyRow>No guests match.</EmptyRow>
          ) : (
            filteredGuests.map((g) => <GuestItem key={g.participantKey} guest={g} />)
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-paper/10 last:border-b-0">
      <div className="px-3 pt-2 pb-1 text-xs font-bold uppercase tracking-wider text-paper/40">
        {title}
      </div>
      <ul className="flex flex-col">{children}</ul>
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="px-3 py-2 text-xs uppercase tracking-wider text-paper/40">
      {children}
    </li>
  );
}

function NpcItem({
  npc,
  buildingLabel,
}: {
  npc: NpcRow;
  buildingLabel: string;
}) {
  return (
    <li className="flex items-start gap-2 px-3 py-2 hover:bg-white/5">
      <CharacterAvatar character={null} seed={npc.name} size={24} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-bold uppercase tracking-wider text-paper">
            {npc.name}
          </span>
          <span className="shrink-0 text-xs uppercase tracking-wider text-paper/50">
            · {buildingLabel}
          </span>
        </div>
        {npc.description ? (
          <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-paper/60">
            {npc.description}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function GuestItem({ guest }: { guest: RemotePlayer }) {
  return (
    <li className="flex items-center gap-2 px-3 py-2 hover:bg-white/5">
      <CharacterAvatar
        character={guest.character}
        seed={guest.name}
        size={24}
      />
      <span className="truncate text-xs font-bold uppercase tracking-wider text-paper">
        {guest.name}
      </span>
    </li>
  );
}
