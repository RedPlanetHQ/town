"use client";

// Bottom-right non-modal overlay with a Slack-style left sidebar for
// topics + a right column with the active thread's messages and
// composer. Renders only when the store says `open` is true. The game
// keeps running underneath — this is deliberately NOT in ui.isPaused()
// so the player can walk while the panel is up.
//
// Visual language matches the existing Chat / Panel surfaces
// (paper background, 2px ink border, h240 accent for the local
// player's bubbles).

import { useEffect, useMemo, useRef, useState } from "react";

import {
  MAX_TOPICS_PER_BUILDING,
  MAX_TOPICS_PER_USER,
  TOPIC_TITLE_MAX,
  type GroupTopicRow,
} from "../types";
import {
  closeRoom,
  createTopic,
  deleteTopic,
  postMessage,
  publishTyping,
  switchTopic,
} from "../client/channel";
import { getSelfIdentity } from "@/game/realtime";
import { useGroupChatState } from "../client/useGroupChatState";
import {
  selectActiveMessages,
  selectActiveTyping,
} from "../client/store";
import { authorColor } from "./authorColor";

export function GroupChatSurface() {
  const state = useGroupChatState();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");

  const activeMessages = useMemo(
    () => selectActiveMessages(state),
    [state],
  );
  const activeTyping = useMemo(
    () => selectActiveTyping(state),
    [state],
  );

  // Keep the list pinned to the bottom on new messages / typing
  // changes / topic switch. Same pattern as Chat.tsx.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeMessages, activeTyping, state.activeTopicId]);

  // Focus the input the moment the overlay opens (or user switches
  // topic) so the player can type immediately without clicking.
  useEffect(() => {
    if (!state.open) return;
    inputRef.current?.focus();
  }, [state.open, state.activeTopicId]);

  // ESC closes; G is intentionally NOT handled here — the kaplay
  // scene owns G and toggles us via the store, so the close
  // behaviour stays consistent with how the player opened it.
  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      void closeRoom();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.open]);

  const typingNames = useMemo(() => {
    return Array.from(activeTyping.values())
      .map((t) => t.authorName)
      .filter((n) => !!n);
  }, [activeTyping]);

  if (!state.open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    void postMessage(text);
    queueMicrotask(() => inputRef.current?.focus());
  };

  const ownerKey = state.room?.ownerParticipantKey ?? "";
  // Same-tab identity — used to gate the owner-only "delete topic" ×.
  // The server enforces on DELETE regardless, but hiding the button for
  // non-owners avoids offering an action they can't take.
  const selfKey = getSelfIdentity()?.participantKey ?? "";
  const viewerIsOwner = ownerKey !== "" && ownerKey === selfKey;
  const activeTopic = state.topics.find((t) => t.id === state.activeTopicId);
  const activeTitle =
    state.activeTopicId === null ? "general" : activeTopic?.title ?? "topic";

  return (
    <div className="nb-card-dark pointer-events-auto fixed bottom-12 right-4 z-30 flex w-[560px] flex-col gap-2 p-0">
      <div className="flex items-center justify-between gap-2 border-b-2 border-paper/15 px-3 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-paper">
            Group chat
          </span>
          {state.room ? (
            <span className="text-xs uppercase tracking-wider text-paper/60">
              · {state.room.buildingLabel} · #{activeTitle}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void closeRoom()}
          className="border-2 border-paper/30 bg-transparent px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10"
          aria-label="Close group chat (G or ESC)"
          title="Close (G or ESC)"
        >
          ESC
        </button>
      </div>

      <div className="flex min-h-[360px] gap-0">
        <TopicSidebar
          topics={state.topics}
          activeTopicId={state.activeTopicId}
          unreadByTopic={state.unreadByTopic}
          viewerIsOwner={viewerIsOwner}
        />

        <div className="flex flex-1 flex-col gap-2 p-3">
          {/* Grow the list so the composer sits well below the fold on
              a room with no messages — same "chat lives at the bottom"
              rhythm the DM overlay has. */}
          <div
            ref={listRef}
            className="flex max-h-[50vh] min-h-[300px] flex-1 flex-col gap-1.5 overflow-y-auto pr-1"
          >
            {state.status === "loading" ? (
              <div className="text-xs italic text-paper/60">Connecting…</div>
            ) : null}
            {state.status === "error" ? (
              <div className="text-xs italic text-red-400">
                {state.errorMessage || "Something went wrong"}
              </div>
            ) : null}
            {state.status === "ready" && activeMessages.length === 0 ? (
              <div className="text-xs italic text-paper/60">
                No messages yet in #{activeTitle} — say hi.
              </div>
            ) : null}
            {activeMessages.map((m) => (
              <MessageLine key={m.id} m={m} ownerKey={ownerKey} />
            ))}
          </div>

          {typingNames.length > 0 ? (
            <div className="text-xs italic leading-tight text-paper/70">
              {formatTypingLine(typingNames)}
            </div>
          ) : null}

          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Fire a throttled typing pulse on every keystroke so
                // co-occupants see "X is typing…" land within ~1s.
                if (e.target.value.length > 0) publishTyping();
              }}
              placeholder={`Message #${activeTitle}`}
              className="flex-1 border-2 border-paper/20 bg-black/40 px-2 py-1 text-sm text-paper placeholder:text-paper/40 focus:border-paper/50 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!input.trim()}
              className="border-2 border-paper/20 bg-paper px-2 py-1 text-xs font-bold uppercase tracking-wider text-ink disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function TopicSidebar({
  topics,
  activeTopicId,
  unreadByTopic,
  viewerIsOwner,
}: {
  topics: GroupTopicRow[];
  activeTopicId: string | null;
  unreadByTopic: Map<string, number>;
  viewerIsOwner: boolean;
}) {
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showNew) titleRef.current?.focus();
  }, [showNew]);

  // Tick every 30s so "42m left" labels count down without depending
  // on the store dispatching an unrelated update.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const atRoomCap = topics.length >= MAX_TOPICS_PER_BUILDING;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    setSubmitting(true);
    setError(null);
    const res = await createTopic(t);
    setSubmitting(false);
    if (!res.ok) {
      setError(errorCopy(res.error));
      return;
    }
    setTitle("");
    setShowNew(false);
  };

  const cancelCreate = () => {
    setShowNew(false);
    setTitle("");
    setError(null);
  };

  return (
    <aside className="flex w-[128px] shrink-0 flex-col gap-1 border-r-2 border-paper/15 px-2 py-3">
      <TopicRow
        label="general"
        active={activeTopicId === null}
        unread={unreadByTopic.get("general") ?? 0}
        onClick={() => switchTopic(null)}
      />

      <div className="mt-2 flex items-center justify-between px-1 pb-0.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-paper/50">
          Topics
        </span>
        <button
          type="button"
          disabled={atRoomCap || showNew}
          onClick={() => setShowNew(true)}
          title={
            atRoomCap
              ? `This room is at the ${MAX_TOPICS_PER_BUILDING}-topic cap`
              : "Create a new topic"
          }
          aria-label="Create a new topic"
          className="text-sm font-bold leading-none text-paper/60 hover:text-paper disabled:opacity-30"
        >
          +
        </button>
      </div>

      {topics.map((t) => (
        <TopicRow
          key={t.id}
          label={t.title}
          subline={expiresLabel(t.expiresAt)}
          active={activeTopicId === t.id}
          unread={unreadByTopic.get(t.id) ?? 0}
          onClick={() => switchTopic(t.id)}
          onDelete={
            viewerIsOwner
              ? () => {
                  void deleteTopic(t.id);
                }
              : undefined
          }
        />
      ))}

      {showNew ? (
        <form onSubmit={handleCreate} className="mt-1 flex flex-col gap-1">
          <input
            ref={titleRef}
            type="text"
            value={title}
            maxLength={TOPIC_TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelCreate();
              }
            }}
            placeholder="Topic name"
            className="w-full border-2 border-paper/20 bg-black/40 px-1 py-0.5 text-xs text-paper placeholder:text-paper/40 focus:border-paper/50 focus:outline-none"
          />
          <div className="text-[10px] italic text-paper/50">
            Enter to create · Esc to cancel
          </div>
          {error ? (
            <div className="text-[10px] italic text-red-400">{error}</div>
          ) : null}
        </form>
      ) : null}
    </aside>
  );
}

function TopicRow({
  label,
  subline,
  active,
  unread,
  onClick,
  onDelete,
}: {
  label: string;
  subline?: string;
  active: boolean;
  unread: number;
  onClick: () => void;
  /** Owner-only affordance — omit to hide the × icon. Only user topics
   *  pass this in; #general never does. */
  onDelete?: () => void;
}) {
  return (
    <div
      className={
        "group/topic relative flex items-stretch border-2 transition " +
        (active
          ? "border-paper/50 bg-white/10 text-paper"
          : "border-transparent text-paper/80 hover:bg-white/5")
      }
    >
      <button
        type="button"
        onClick={onClick}
        className="flex flex-1 flex-col items-start gap-0 px-1.5 py-1 text-left"
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span className="truncate text-xs font-bold">#{label}</span>
          {unread > 0 && !active ? (
            <span className="rounded-sm bg-paper px-1 text-[10px] font-bold text-ink">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </div>
        {subline ? (
          <span className="text-[10px] uppercase tracking-wider text-paper/50">
            {subline}
          </span>
        ) : null}
      </button>
      {onDelete ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete topic (owner)"
          aria-label={`Delete topic ${label}`}
          className="flex items-center px-1.5 text-sm leading-none text-paper/40 opacity-0 transition hover:text-red-400 focus:opacity-100 group-hover/topic:opacity-100"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

function MessageLine({
  m,
  ownerKey,
}: {
  m: { authorKey: string; authorName: string; text: string; isNpc: boolean };
  ownerKey: string;
}) {
  // One stable hue per author key. Same user always renders in the
  // same color across messages, refreshes, and both sides of the chat.
  const isOwner = !m.isNpc && ownerKey !== "" && m.authorKey === ownerKey;
  return (
    <div className="text-sm leading-snug text-paper">
      <span
        className="mr-1 font-bold"
        style={{ color: authorColor(m.authorKey) }}
      >
        {m.authorName}
        {isOwner ? (
          <span className="ml-1 text-xs font-bold uppercase tracking-wider text-paper/60">
            (owner)
          </span>
        ) : null}
        :
      </span>
      <span className="whitespace-pre-wrap break-words">{m.text}</span>
    </div>
  );
}

function formatTypingLine(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]} and ${names.length - 1} others are typing…`;
}

/** Human-friendly "42m left" / "3m left" — recomputed on the sidebar's
 *  30s tick. Falls back to "expiring" once < 60s remain and to
 *  "expired" if the client sees an already-past timestamp before the
 *  next prune sweeps it out. */
function expiresLabel(iso: string): string {
  const remaining = new Date(iso).getTime() - Date.now();
  if (remaining <= 0) return "expired";
  const mins = Math.round(remaining / 60_000);
  if (mins < 1) return "expiring";
  return `${mins}m left`;
}

function errorCopy(code: string): string {
  switch (code) {
    case "too-many-topics":
      return `Room is at the ${MAX_TOPICS_PER_BUILDING}-topic cap.`;
    case "user-topic-limit":
      return `You already have ${MAX_TOPICS_PER_USER} active topics here.`;
    case "sign-in-required":
      return "Sign in to create a topic.";
    case "empty-title":
      return "Give the topic a name.";
    default:
      return `Couldn't create topic (${code}).`;
  }
}

