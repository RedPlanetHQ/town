"use client";

// Cmd+K command palette — reads the active plot's buildings and lets
// the player teleport to any of them. Shadcn-flavoured shell around
// `cmdk`: search input at the top, filtered list below, footer with
// keyboard hints. Selection dispatches to the overworld scene through
// the teleport bridge (see game/teleport.ts).

import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";

import { getCachedPlot } from "../game/plotClient";
import { teleportTo } from "../game/teleport";
import { ui } from "./store";

interface BuildingEntry {
  id: string;
  label: string;
  subtitle: string;
}

function buildingLabel(id: string, raw: string | undefined): string {
  if (raw && raw.trim()) return raw;
  return id.replace(/[-_]/g, " ").toUpperCase();
}

function buildingSubtitle(category: string, plotKey: string): string {
  const cat = category.toLowerCase();
  const key = plotKey.replace(/^custom:/, "");
  return `${cat} · ${key}`;
}

export function CommandBar() {
  const [query, setQuery] = useState("");

  // Snapshot the plot at open-time. The palette is short-lived and the
  // plot rarely changes mid-session; re-reading on every keystroke would
  // let a poll-triggered rerender wipe the current selection.
  const buildings = useMemo<BuildingEntry[]>(() => {
    const plot = getCachedPlot();
    if (!plot) return [];
    return plot.buildings.map((b) => ({
      id: b.id,
      label: buildingLabel(b.id, b.label),
      subtitle: buildingSubtitle(b.category, b.plotKey),
    }));
  }, []);

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
                  value={`${b.label} ${b.id} ${b.subtitle}`}
                  onSelect={() => onSelect(b.id)}
                  className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-paper/85 aria-selected:bg-paper/[0.08] aria-selected:text-paper"
                >
                  <span className="flex flex-col gap-0.5 truncate">
                    <span className="truncate font-medium">{b.label}</span>
                    <span className="truncate text-[10px] uppercase tracking-[0.18em] text-paper/45">
                      {b.subtitle}
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
