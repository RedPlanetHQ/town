"use client";

// Right-edge slide-in panel that shows the town's recent activity:
// visits, NPC chats, tag/item awards, and group-chat sessions. Opened
// via the FEED button in the top-right HUD stack; closed via the X, the
// FEED toggle, or Escape.
//
// Polls /api/towns/[slug]/activity every 20s while open. No realtime
// for v1 — these events are slow and the poll cost is trivial.

import { useEffect, useMemo, useState } from "react";

import { ui } from "./store";

const POLL_INTERVAL_MS = 20 * 1000;
const PAGE_SIZE = 50;

type ActivityKind =
  | "visit"
  | "npc_chat"
  | "tag_awarded"
  | "item_awarded"
  | "group_chat_started";

interface ActivityRow {
  id: string;
  kind: ActivityKind;
  subjectKey: string;
  subjectName: string;
  subjectCharacter: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const KIND_ICON: Record<ActivityKind, string> = {
  visit: "🚪",
  npc_chat: "💬",
  tag_awarded: "🏷️",
  item_awarded: "🎁",
  group_chat_started: "🗣️",
};

export function ActivityFeed({ townSlug }: { townSlug: string }) {
  const [items, setItems] = useState<ActivityRow[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    const fetchOnce = async () => {
      try {
        const res = await fetch(
          `/api/towns/${encodeURIComponent(townSlug)}/activity?limit=${PAGE_SIZE}`,
          { signal: ctrl.signal, cache: "no-store" },
        );
        if (!res.ok) {
          if (!cancelled) setStatus("error");
          return;
        }
        const body = (await res.json()) as { items?: ActivityRow[] };
        if (cancelled) return;
        setItems(body.items ?? []);
        setStatus("ready");
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        if (!cancelled) setStatus("error");
      }
    };

    void fetchOnce();
    const id = window.setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearInterval(id);
    };
  }, [townSlug]);

  // Esc closes the panel — same behaviour as the other right-side
  // overlays (Suggestions, Explorer).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        ui.closeFeed();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="pointer-events-auto absolute right-0 top-0 z-40 flex h-full w-[360px] flex-col border-l-2 border-ink bg-[#0c0d12] text-paper shadow-[-6px_0_0_0_rgba(0,0,0,0.4)]">
      <div className="flex items-center justify-between border-b-2 border-ink/40 px-4 py-3">
        <span className="text-[12px] font-bold uppercase tracking-[0.25em] text-[#f0e442]">
          Town activity
        </span>
        <button
          type="button"
          aria-label="Close feed"
          onClick={() => ui.closeFeed()}
          className="text-[14px] font-bold leading-none text-paper/70 hover:text-paper"
        >
          ×
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {status === "loading" ? (
          <FeedMessage>Loading…</FeedMessage>
        ) : status === "error" ? (
          <FeedMessage>Couldn't load activity.</FeedMessage>
        ) : items.length === 0 ? (
          <FeedMessage>No activity yet.</FeedMessage>
        ) : (
          <ul className="flex flex-col">
            {items.map((row) => (
              <FeedItem key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FeedMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-6 text-center text-[12px] uppercase tracking-wider text-paper/50">
      {children}
    </div>
  );
}

function FeedItem({ row }: { row: ActivityRow }) {
  const sentence = useMemo(() => describeActivity(row), [row]);
  const relative = useRelativeTime(row.createdAt);
  return (
    <li className="border-b border-paper/10 py-3 last:border-b-0">
      <div className="px-1 text-[10px] uppercase tracking-wider text-paper/50">
        {relative}
      </div>
      <div className="mt-1 flex items-start gap-2 px-1">
        <InitialTile name={row.subjectName} />
        <div className="flex-1 text-[12px] uppercase leading-snug tracking-wider text-[#f0e442]">
          <span aria-hidden className="mr-1 text-[13px]">
            {KIND_ICON[row.kind]}
          </span>
          {sentence}
        </div>
      </div>
    </li>
  );
}

// Color a tile from the visitor's display name so the same person stays
// the same color across feed rows. FNV-1a hue ramp — same idea as the
// group-chat author colors.
const TILE_PALETTE = [
  "#f0e442", // yellow
  "#56b4e9", // sky
  "#cc79a7", // pink
  "#009e73", // green
  "#e69f00", // orange
  "#0072b2", // blue
] as const;

function tileColorFor(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return TILE_PALETTE[Math.abs(h) % TILE_PALETTE.length]!;
}

function InitialTile({ name }: { name: string }) {
  const letter = (name.replace(/^@+/, "").trim()[0] ?? "?").toUpperCase();
  const bg = useMemo(() => tileColorFor(name), [name]);
  return (
    <div
      className="mt-[2px] flex h-6 w-6 shrink-0 items-center justify-center border border-paper/30 text-[11px] font-black text-ink"
      style={{ background: bg }}
    >
      {letter}
    </div>
  );
}

function describeActivity(row: ActivityRow): string {
  const name = `@${row.subjectName}`;
  switch (row.kind) {
    case "visit":
      return `${name} arrived`;
    case "npc_chat": {
      const npc = stringField(row.metadata, "npcName") ?? "an NPC";
      return `${name} talked to ${npc}`;
    }
    case "tag_awarded": {
      const tag =
        stringField(row.metadata, "tagLabel") ??
        stringField(row.metadata, "tagId") ??
        "a tag";
      return `${name} earned "${tag}"`;
    }
    case "item_awarded": {
      const template =
        stringField(row.metadata, "templateLabel") ??
        stringField(row.metadata, "templateId") ??
        "an item";
      return `${name} received ${template}`;
    }
    case "group_chat_started": {
      const building =
        stringField(row.metadata, "buildingLabel") ??
        stringField(row.metadata, "buildingId") ??
        "a building";
      return `${name} started a group chat in ${building}`;
    }
    default:
      return `${name} did something`;
  }
}

function stringField(
  meta: Record<string, unknown>,
  key: string,
): string | null {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function useRelativeTime(iso: string): string {
  // Re-renders every 30s while the panel is open so "12 min ago" keeps
  // up. Avoids an Intl.RelativeTimeFormat dep — the catalog of buckets
  // here is small and matches the reference design's voice.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => window.clearInterval(id);
  }, []);
  const delta = Math.max(0, now - new Date(iso).getTime());
  const sec = Math.floor(delta / 1000);
  if (sec < 30) return "just now";
  if (sec < 60) return `${sec} sec ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
