"use client";

// Non-modal overlay with a Slack-style left sidebar for topics + a
// right column with the active thread's messages and composer. Renders
// only when the store says `open` is true. The game keeps running
// underneath — this is deliberately NOT in ui.isPaused() so the player
// can walk while the panel is up.
//
// Visual language matches Chat.tsx — flat rectangles, subtle
// white/10 hairline borders, one accent voice (town yellow) for the
// room's badges + the SEND button. Expired topics render read-only
// so players can scroll transcripts but cannot post; composer swaps
// in a disabled banner instead.

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
import {
  CloseIcon,
  ExpandIcon,
  PlusIcon,
  RestoreIcon,
} from "@/ui/chat-icons";
import { useGroupChatState } from "../client/useGroupChatState";
import { selectActiveMessages, selectActiveTyping } from "../client/store";
import { authorColor } from "./authorColor";

type WindowMode = "compact" | "expanded";

const ROOM_ACCENT = "#dcb016";
const SURFACE_RAISED = "#171a20";

export function GroupChatSurface() {
  const state = useGroupChatState();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<WindowMode>("compact");

  const activeMessages = useMemo(() => selectActiveMessages(state), [state]);
  const activeTyping = useMemo(() => selectActiveTyping(state), [state]);

  // Reset window mode each time a fresh room opens so the player
  // isn't stuck in an expanded state left over from the last house.
  useEffect(() => {
    if (state.open) return;
    setMode("compact");
  }, [state.open]);

  // Keep the list pinned to the bottom on new messages / typing
  // changes / topic switch / mode change.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeMessages, activeTyping, state.activeTopicId, mode]);

  useEffect(() => {
    if (!state.open) return;
    inputRef.current?.focus();
  }, [state.open, state.activeTopicId, mode]);

  // ESC in expanded mode drops back to compact instead of closing the
  // room. From compact ESC closes the room. G is intentionally NOT
  // handled here — the kaplay scene owns G and toggles us via the
  // store.
  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (mode === "expanded") {
        e.preventDefault();
        e.stopPropagation();
        setMode("compact");
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      void closeRoom();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.open, mode]);

  const typingNames = useMemo(() => {
    return Array.from(activeTyping.values())
      .map((t) => t.authorName)
      .filter((n) => !!n);
  }, [activeTyping]);

  if (!state.open) return null;

  const ownerKey = state.room?.ownerParticipantKey ?? "";
  // Same-tab identity — used to gate the owner-only "delete topic" ×.
  // The server enforces on DELETE regardless, but hiding the button for
  // non-owners avoids offering an action they can't take.
  const selfKey = getSelfIdentity()?.participantKey ?? "";
  const viewerIsOwner = ownerKey !== "" && ownerKey === selfKey;
  const activeTopic = state.topics.find((t) => t.id === state.activeTopicId);
  const activeTitle =
    state.activeTopicId === null ? "general" : (activeTopic?.title ?? "topic");
  const activeIsExpired =
    activeTopic !== undefined && isTopicExpired(activeTopic);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (activeIsExpired) return;
    const text = input.trim();
    if (!text) return;
    setInput("");
    void postMessage(text);
    queueMicrotask(() => inputRef.current?.focus());
  };

  const isExpanded = mode === "expanded";
  const wrapperCls = shellForMode(mode);
  const listHeightCls = isExpanded
    ? "flex-1 min-h-0"
    : "flex-1 max-h-[50vh] min-h-[300px]";

  return (
    <div
      className={`${wrapperCls} pointer-events-auto flex flex-col overflow-hidden border border-white/10 bg-[#0e1116] text-paper`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="h-9 w-9 shrink-0 border border-white/10"
            style={{ background: ROOM_ACCENT }}
            aria-hidden
          />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="text-[11px] font-bold uppercase tracking-wider text-paper/50">
              Group chat
            </span>
            <span className="truncate text-sm font-black uppercase tracking-wide text-paper">
              {state.room ? state.room.buildingLabel : "Loading…"}
              <span className="text-paper/60"> · #{activeTitle}</span>
              {activeIsExpired ? (
                <span className="ml-2 inline-flex items-center border border-white/10 bg-paper/10 px-1.5 py-0.5 text-[10px] font-black tracking-wider text-paper/80">
                  expired
                </span>
              ) : null}
            </span>
          </div>
        </div>
        <WindowControls
          mode={mode}
          onExpand={() => setMode("expanded")}
          onRestore={() => setMode("compact")}
          onClose={() => void closeRoom()}
        />
      </div>

      <div
        className={`flex min-h-0 flex-1 gap-0 ${isExpanded ? "" : "min-h-[360px]"}`}
      >
        <TopicSidebar
          topics={state.topics}
          activeTopicId={state.activeTopicId}
          unreadByTopic={state.unreadByTopic}
          viewerIsOwner={viewerIsOwner}
          expanded={isExpanded}
        />

        <div
          className={`flex min-h-0 flex-1 flex-col gap-3 ${
            isExpanded ? "p-5" : "p-4"
          }`}
        >
          <div
            ref={listRef}
            className={`${listHeightCls} flex flex-col gap-2 overflow-y-auto pr-1`}
          >
            {state.status === "loading" ? (
              <div className="text-xs font-bold uppercase tracking-wider text-paper/50">
                Connecting…
              </div>
            ) : null}
            {state.status === "error" ? (
              <div className="text-xs font-bold uppercase tracking-wider text-red-400">
                {state.errorMessage || "Something went wrong"}
              </div>
            ) : null}
            {state.status === "ready" && activeMessages.length === 0 ? (
              <div className="text-xs font-bold uppercase tracking-wider text-paper/50">
                {activeIsExpired
                  ? `#${activeTitle} expired with no messages.`
                  : `No messages yet in #${activeTitle} — say hi.`}
              </div>
            ) : null}
            {activeMessages.map((m) => (
              <MessageLine
                key={m.id}
                m={m}
                ownerKey={ownerKey}
                expanded={isExpanded}
              />
            ))}
          </div>

          {typingNames.length > 0 && !activeIsExpired ? (
            <div className="text-xs italic leading-tight text-paper/60">
              {formatTypingLine(typingNames)}
            </div>
          ) : null}

          {activeIsExpired ? (
            <div className="border border-white/15 bg-paper/5 px-3 py-2.5 text-xs font-medium text-paper/70">
              This topic expired. Scroll the transcript — sending is off.
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex items-center gap-3">
              <div
                className="flex flex-1 items-center border border-white/15 bg-[color:var(--surface-raised)] px-4 py-2 focus-within:border-white/30 transition-colors duration-100"
                style={{ ["--surface-raised" as string]: SURFACE_RAISED }}
              >
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
                  className={`w-full bg-transparent font-medium text-paper placeholder:text-paper/40 focus:outline-none ${
                    isExpanded ? "text-base" : "text-sm"
                  }`}
                />
              </div>
              <button
                type="submit"
                disabled={!input.trim()}
                className={`shrink-0 border border-white/10 font-black uppercase tracking-wide text-ink transition-[opacity,background] duration-100 disabled:cursor-not-allowed disabled:opacity-50 ${
                  isExpanded ? "px-5 py-3 text-sm" : "px-4 py-2.5 text-xs"
                }`}
                style={{ background: ROOM_ACCENT }}
              >
                Send
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function shellForMode(mode: WindowMode): string {
  if (mode === "expanded") {
    // z-40 so the modal covers the app chrome (BottomToolbar +
    // BottomBar + Hud rows all at z-30).
    return "fixed inset-4 z-40 md:inset-8";
  }
  return "fixed bottom-12 right-4 z-30 w-[560px]";
}

function TopicSidebar({
  topics,
  activeTopicId,
  unreadByTopic,
  viewerIsOwner,
  expanded,
}: {
  topics: GroupTopicRow[];
  activeTopicId: string | null;
  unreadByTopic: Map<string, number>;
  viewerIsOwner: boolean;
  expanded: boolean;
}) {
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showNew) titleRef.current?.focus();
  }, [showNew]);

  // Tick every 30s so "42m left" / "expired" labels count down without
  // depending on the store dispatching an unrelated update.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const active = topics.filter((t) => !isTopicExpired(t));
  const expired = topics.filter((t) => isTopicExpired(t));
  // Only ACTIVE topics count against the room cap.
  const atRoomCap = active.length >= MAX_TOPICS_PER_BUILDING;

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

  const sidebarWidth = expanded ? "w-[240px]" : "w-[148px]";

  return (
    <aside
      className={`${sidebarWidth} flex shrink-0 flex-col gap-1 overflow-y-auto border-r border-white/8 bg-black/25 px-2.5 py-3`}
    >
      <TopicRow
        label="general"
        active={activeTopicId === null}
        unread={unreadByTopic.get("general") ?? 0}
        onClick={() => switchTopic(null)}
      />

      <div className="mt-3 flex items-center justify-between px-1 pb-1">
        <span className="text-[10px] font-black uppercase tracking-widest text-paper/60">
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
          className="flex h-6 w-6 items-center justify-center border border-white/15 text-paper/80 transition-[background,color,border-color] duration-100 hover:border-white/30 hover:bg-paper/10 hover:text-paper disabled:cursor-not-allowed disabled:opacity-30"
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {active.map((t) => (
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
        <form onSubmit={handleCreate} className="mt-1 flex flex-col gap-1 px-1">
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
            className="w-full border border-white/15 bg-[#171a20] px-2 py-1 text-xs font-medium text-paper placeholder:text-paper/40 outline-none focus:border-white/30"
          />
          <div className="text-[10px] font-bold uppercase tracking-wider text-paper/50">
            Enter to create · Esc to cancel
          </div>
          {error ? (
            <div className="text-[10px] font-bold uppercase tracking-wider text-red-400">
              {error}
            </div>
          ) : null}
        </form>
      ) : null}

      {expired.length > 0 ? (
        <>
          <div className="mt-4 flex items-center justify-between px-1 pb-1">
            <span className="text-[10px] font-black uppercase tracking-widest text-paper/50">
              Expired
            </span>
          </div>
          {expired.map((t) => (
            <TopicRow
              key={t.id}
              label={t.title}
              subline="read-only"
              active={activeTopicId === t.id}
              unread={0}
              expired
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
        </>
      ) : null}
    </aside>
  );
}

function TopicRow({
  label,
  subline,
  active,
  unread,
  expired,
  onClick,
  onDelete,
}: {
  label: string;
  subline?: string;
  active: boolean;
  unread: number;
  expired?: boolean;
  onClick: () => void;
  /** Owner-only affordance — omit to hide the × icon. Only user topics
   * pass this in; #general never does. */
  onDelete?: () => void;
}) {
  return (
    <div
      className={
        "group/topic relative flex items-stretch transition-[background,border-color] duration-100 " +
        (active
          ? "border border-white/10 bg-paper/10 text-paper"
          : expired
            ? "border border-transparent text-paper/50 hover:bg-paper/5"
            : "border border-transparent text-paper/85 hover:bg-paper/5")
      }
    >
      <button
        type="button"
        onClick={onClick}
        className="flex flex-1 flex-col items-start gap-0 px-2.5 py-1.5 text-left"
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span
            className={`truncate text-xs font-black uppercase tracking-wide ${expired ? "line-through decoration-paper/40" : ""}`}
          >
            #{label}
          </span>
          {unread > 0 && !active ? (
            <span
              className="border border-white/10 px-1.5 py-0.5 text-[10px] font-black leading-none text-ink"
              style={{ background: ROOM_ACCENT }}
            >
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </div>
        {subline ? (
          <span
            className={`text-[10px] font-bold uppercase tracking-wider ${expired ? "text-paper/40" : "text-paper/50"}`}
          >
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
          className="flex items-center px-2 text-paper/40 opacity-0 transition-colors hover:text-red-400 focus:opacity-100 group-hover/topic:opacity-100"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function MessageLine({
  m,
  ownerKey,
  expanded,
}: {
  m: {
    authorKey: string;
    authorName: string;
    text: string;
    isNpc: boolean;
    createdAt?: string;
  };
  ownerKey: string;
  expanded: boolean;
}) {
  // One stable hue per author key. Same user always renders in the
  // same color across messages, refreshes, and both sides of the chat.
  const isOwner = !m.isNpc && ownerKey !== "" && m.authorKey === ownerKey;
  return (
    <div
      className={`${expanded ? "text-base leading-relaxed" : "text-sm leading-snug"} font-medium text-paper`}
    >
      <span
        className="mr-1.5 font-black"
        style={{ color: authorColor(m.authorKey) }}
      >
        {m.authorName}
        {isOwner ? (
          <span className="ml-1 inline-flex items-center border border-white/15 bg-white/5 px-1 py-0.5 text-[9px] font-black uppercase tracking-wider text-paper/80">
            owner
          </span>
        ) : null}
        :
      </span>
      <span className="whitespace-pre-wrap break-words">{m.text}</span>
    </div>
  );
}

function WindowControls({
  mode,
  onExpand,
  onRestore,
  onClose,
}: {
  mode: WindowMode;
  onExpand: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {mode === "expanded" ? (
        <IconButton
          onClick={onRestore}
          title="Restore"
          aria-label="Restore window size"
        >
          <RestoreIcon className="h-4 w-4" />
        </IconButton>
      ) : (
        <IconButton
          onClick={onExpand}
          title="Expand"
          aria-label="Expand to full screen"
        >
          <ExpandIcon className="h-4 w-4" />
        </IconButton>
      )}
      <IconButton onClick={onClose} title="Close" aria-label="Close group chat">
        <CloseIcon className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  title,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-8 w-8 items-center justify-center border border-white/15 bg-transparent text-paper/80 transition-[background,color,border-color] duration-100 hover:border-white/30 hover:bg-paper/10 hover:text-paper"
      {...rest}
    >
      {children}
    </button>
  );
}

function formatTypingLine(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]} and ${names.length - 1} others are typing…`;
}

/** Human-friendly "42m left" / "3m left" — recomputed on the sidebar's
 * 30s tick. Falls back to "expiring" once < 60s remain and to
 * "expired" if the client sees an already-past timestamp before the
 * next prune sweeps it out. */
function expiresLabel(iso: string): string {
  const remaining = new Date(iso).getTime() - Date.now();
  if (remaining <= 0) return "expired";
  const mins = Math.round(remaining / 60_000);
  if (mins < 1) return "expiring";
  return `${mins}m left`;
}

function isTopicExpired(topic: GroupTopicRow): boolean {
  return new Date(topic.expiresAt).getTime() <= Date.now();
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
