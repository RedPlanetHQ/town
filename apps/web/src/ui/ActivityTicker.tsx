"use client";

// One-row rotating display of the town's last ~10 events. Lives inside
// the BottomBar next to the "Town activity" toggle so a passive viewer
// always sees something happening without opening the popover.
//
// Rotation rules:
//   • Cycle once every TICK_MS, skipping empty windows.
//   • When the upstream list changes (new event lands, or items get
//     dropped past the window), reset the cursor to the newest event —
//     that keeps the latest beat visible instead of waiting for the
//     current rotation to wrap around.
//   • Pause on hover so a player who wants to read a long sentence can.

import { useEffect, useMemo, useRef, useState } from "react";

import { CharacterAvatar } from "./CharacterAvatar";
import {
  describeActivity,
  formatRelativeTime,
} from "./ActivityFeed";
import type { ActivityRow } from "./useTownActivity";

const TICK_MS = 4_500;
const WINDOW = 10;

export function ActivityTicker({ items }: { items: ActivityRow[] }) {
  const visible = useMemo(() => items.slice(0, WINDOW), [items]);
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);

  // Track the newest id so we can detect "a new event landed" without
  // depending on the full array reference (the polling hook returns
  // a fresh array even when the contents haven't changed).
  const lastNewestId = useRef<string | null>(null);
  useEffect(() => {
    const newest = visible[0]?.id ?? null;
    if (newest !== lastNewestId.current) {
      lastNewestId.current = newest;
      setIndex(0);
    } else if (index >= visible.length) {
      // List shrank past the cursor — clamp back into range.
      setIndex(0);
    }
  }, [visible, index]);

  useEffect(() => {
    if (visible.length <= 1) return;
    if (hovered) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % visible.length);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [visible.length, hovered]);

  if (visible.length === 0) {
    return (
      <div className="flex h-7 items-center justify-end text-xs uppercase tracking-wider text-paper/40">
        No activity yet
      </div>
    );
  }

  const row = visible[Math.min(index, visible.length - 1)]!;
  return (
    <div
      className="flex items-center justify-end gap-2"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-live="polite"
      aria-atomic="true"
    >
      <CharacterAvatar
        character={row.subjectCharacter}
        seed={row.subjectName}
        size={20}
      />
      <TickerLine row={row} />
    </div>
  );
}

function TickerLine({ row }: { row: ActivityRow }) {
  const sentence = useMemo(() => describeActivity(row), [row]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const relative = formatRelativeTime(now - new Date(row.createdAt).getTime());
  return (
    <span className="flex items-baseline gap-2 truncate text-xs font-bold uppercase tracking-wider text-paper">
      <span className="truncate">{sentence}</span>
      <span className="text-paper/50">· {relative}</span>
    </span>
  );
}
