"use client";

// Popover anchored above the BottomBar's "Town activity" button. Lists
// the recent town events: visits, NPC chats, tag/item awards, group
// chats. The poll lives in useTownActivity so the bottom-bar ticker can
// share the same data without firing a second request.
//
// Closes on the X, the "Town activity" toggle in the BottomBar, and
// Escape.

import { useEffect, useMemo, useState } from "react";

import { CharacterAvatar } from "./CharacterAvatar";
import { ui } from "./store";
import {
  type ActivityKind,
  type ActivityRow,
  type ActivityStatus,
} from "./useTownActivity";

// Color-code each row by kind via a thin left border. Avoids a second
// tile next to the avatar (read as a category code) and lets the
// sentence's verb carry the meaning.
const KIND_ACCENT: Record<ActivityKind, string> = {
  visit: "#dcb016", // yellow — arrival / active
  npc_chat: "#67bfe1", // sky — conversation
  tag_awarded: "#e194ad", // pink — earned
  item_awarded: "#aaba6c", // olive — gift
  group_chat_started: "#e67333", // orange — room
};

const KIND_BADGE: Record<ActivityKind, string> = {
  visit: "City",
  npc_chat: "Chat",
  tag_awarded: "Earned",
  item_awarded: "Gift",
  group_chat_started: "Room",
};

export interface ActivityFeedProps {
  items: ActivityRow[];
  status: ActivityStatus;
}

export function ActivityFeed({ items, status }: ActivityFeedProps) {
  // Esc closes the popover — same behaviour as the other overlays
  // (Suggestions, Explorer).
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

  const { now, earlier } = useMemo(() => splitByRecency(items), [items]);

  return (
    <div
      className="nb-card-dark pointer-events-auto absolute right-3 z-40 flex flex-col"
      style={{
        bottom: 36,
        width: 380,
        maxHeight: "70vh",
      }}
      role="dialog"
      aria-label="Town activity"
    >
      <div className="flex items-center justify-between border-b-2 border-paper/10 px-3 py-2">
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-paper">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: "#dcb016" }}
          />
          Town activity
        </span>
        <button
          type="button"
          aria-label="Close feed"
          onClick={() => ui.closeFeed()}
          className="inline-flex h-6 w-6 items-center justify-center text-base font-bold leading-none text-paper/70 hover:bg-white/10 hover:text-paper"
        >
          ×
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {status === "loading" ? (
          <FeedMessage>Loading…</FeedMessage>
        ) : status === "error" ? (
          <FeedMessage>Couldn&apos;t load activity.</FeedMessage>
        ) : items.length === 0 ? (
          <FeedMessage>No activity yet.</FeedMessage>
        ) : (
          <>
            {now.length > 0 ? (
              <FeedSection title="Happening now" rows={now} />
            ) : null}
            {earlier.length > 0 ? (
              <FeedSection title="Earlier today" rows={earlier} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// Rows newer than RECENT_WINDOW_MS bubble to a "Happening now" section
// above the rest — same grouping as the reference design.
const RECENT_WINDOW_MS = 30 * 60 * 1000;

function splitByRecency(rows: ActivityRow[]): {
  now: ActivityRow[];
  earlier: ActivityRow[];
} {
  const threshold = Date.now() - RECENT_WINDOW_MS;
  const now: ActivityRow[] = [];
  const earlier: ActivityRow[] = [];
  for (const r of rows) {
    if (new Date(r.createdAt).getTime() >= threshold) now.push(r);
    else earlier.push(r);
  }
  return { now, earlier };
}

function FeedSection({
  title,
  rows,
}: {
  title: string;
  rows: ActivityRow[];
}) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="px-1 py-1 text-xs font-bold uppercase tracking-wider text-paper/40">
        {title}
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <FeedItem key={row.id} row={row} />
        ))}
      </ul>
    </div>
  );
}

function FeedMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-6 text-center text-xs uppercase tracking-wider text-paper/40">
      {children}
    </div>
  );
}

function FeedItem({ row }: { row: ActivityRow }) {
  const sentence = useMemo(() => describeActivity(row), [row]);
  const relative = useRelativeTime(row.createdAt);
  return (
    <li
      className="border-l-2 bg-white/[0.03] py-2 pl-2 pr-2"
      style={{ borderLeftColor: KIND_ACCENT[row.kind] }}
    >
      <div className="flex items-start gap-2">
        <CharacterAvatar
          character={row.subjectCharacter}
          seed={row.subjectName}
          size={28}
        />
        <div className="flex-1 min-w-0">
          <div className="truncate text-xs font-bold uppercase tracking-wider text-paper">
            {sentence}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs uppercase tracking-wider text-paper/50">
            <span style={{ color: KIND_ACCENT[row.kind] }}>
              {KIND_BADGE[row.kind]}
            </span>
            <span aria-hidden>·</span>
            <span>{relative}</span>
          </div>
        </div>
      </div>
    </li>
  );
}

export function describeActivity(row: ActivityRow): string {
  const name = `@${row.subjectName}`;
  switch (row.kind) {
    case "visit":
      return `${name} is active in the city`;
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
  return formatRelativeTime(now - new Date(iso).getTime());
}

export function formatRelativeTime(deltaMs: number): string {
  const delta = Math.max(0, deltaMs);
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
