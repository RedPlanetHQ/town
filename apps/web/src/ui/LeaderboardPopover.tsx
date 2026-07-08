"use client";

// Popover anchored under the Leaderboard HudButton. One list: visitors
// to this town ranked by items + tags earned in this town. Fetched
// from /api/towns/[slug]/leaderboard on open; the parent gates the
// button on having a slug at all.
//
// Same interaction pattern as PopulationPopover — outside click + Esc
// close, X button, right-aligned dark card, capped height with scroll.

import { useEffect, useRef, useState } from "react";

import { CharacterAvatar } from "./CharacterAvatar";

interface Row {
  subjectKey: string;
  name: string;
  character: string | null;
  itemCount: number;
  tagCount: number;
  score: number;
}

interface LeaderboardPopoverProps {
  townSlug: string;
  onClose: () => void;
}

export function LeaderboardPopover({
  townSlug,
  onClose,
}: LeaderboardPopoverProps) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const url = `/api/towns/${encodeURIComponent(townSlug)}/leaderboard`;
    void (async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setError(`Failed (${res.status})`);
          return;
        }
        const body = (await res.json()) as { rows: Row[] };
        if (!cancelled) setRows(body.rows);
      } catch {
        if (!cancelled) setError("Network error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [townSlug]);

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

  return (
    <div
      ref={rootRef}
      className="nb-card-dark absolute right-0 z-40 mt-2 flex flex-col"
      style={{ top: "100%", width: 320, height: 440, maxHeight: "70vh" }}
      role="dialog"
      aria-label="Town leaderboard"
    >
      <div className="flex items-center justify-between gap-2 border-b-2 border-paper/15 px-3 py-2">
        <span className="text-xs font-bold uppercase tracking-wider text-paper">
          Leaderboard
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close leaderboard"
          className="inline-flex h-6 w-6 items-center justify-center text-base font-bold leading-none text-paper/70 hover:bg-white/10 hover:text-paper"
        >
          ×
        </button>
      </div>

      <div className="border-b border-paper/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-paper/40">
        The visitors who&apos;ve made the most of this town.
      </div>

      <div className="flex-1 overflow-y-auto">
        {error ? (
          <EmptyRow>{error}</EmptyRow>
        ) : rows === null ? (
          <EmptyRow>Loading…</EmptyRow>
        ) : rows.length === 0 ? (
          <EmptyRow>Nobody&apos;s earned anything yet.</EmptyRow>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row, i) => (
              <LeaderboardRow key={row.subjectKey} rank={i + 1} row={row} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-4 text-center text-xs uppercase tracking-wider text-paper/40">
      {children}
    </div>
  );
}

function LeaderboardRow({ rank, row }: { rank: number; row: Row }) {
  const rankColor = rank === 1 ? "text-primary" : "text-paper/50";
  return (
    <li className="flex items-center gap-3 border-b border-paper/10 px-3 py-2 last:border-b-0 hover:bg-white/5">
      <span
        className={`w-5 shrink-0 text-right font-mono text-[11px] font-bold ${rankColor}`}
      >
        {rank}
      </span>
      <CharacterAvatar character={row.character} seed={row.name} size={24} />
      <span className="min-w-0 flex-1 truncate text-xs font-bold uppercase tracking-wider text-paper">
        {row.name}
      </span>
      <span
        className="shrink-0 font-mono text-xs font-bold text-paper"
        title={`${row.itemCount} items · ${row.tagCount} tags`}
      >
        {row.score}
      </span>
    </li>
  );
}
