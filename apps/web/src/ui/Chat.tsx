"use client";

// Streaming NPC chat overlay. Uses the AI-SDK `useChat` hook against
// /api/npc-chat. The system prompt is composed server-side from the
// NPC's row (Npc table or system-npcs/) plus the chat mode (direct vs
// invited). The route exposes a memory_search tool that hits CORE
// /api/v1/search with the user's PAT/access-token; we render only
// assistant text here — tool calls happen quietly behind the scenes.
//
// Visual language: dark, flat, blocky.
// - Flat rectangles, no rounding
// - Subtle white/10 hairline borders (never bright paper), no hard
//   drop shadows — chrome recedes so content leads
// - One accent voice per NPC (their `accent` colour): used for the
//   avatar block, the viewer's own bubbles, and the SEND button
// - Expanded mode centres the transcript in a max-w-3xl column so a
//   full-screen dark backdrop doesn't read as "empty room"

import { useEffect, useRef, useState } from "react";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

import { getActiveTownSlug } from "../game/plotClient";
import { CloseIcon, ExpandIcon, RestoreIcon } from "./chat-icons";
import { ui, type ChatState } from "./store";

type WindowMode = "compact" | "expanded";

// Surface below the outer card border — slightly lighter than the
// backdrop so bubbles + composer read as raised.
const SURFACE = "#0e1116";
const SURFACE_RAISED = "#171a20";

export function Chat({ chat }: { chat: NonNullable<ChatState> }) {
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<WindowMode>("compact");

  // Greeting message shown above the input on first paint so the player
  // sees who they're talking to before the LLM streams its first turn.
  const greeting = `Hi, I'm ${chat.speaker}. ${chat.description}`.trim();

  // Always send the active town slug — visitor or owner. Visitor mode
  // needs it so the server resolves NPCs against the TOWN OWNER's
  // user id (not the caller). Owner mode needs it because multi-town
  // owners would otherwise hit the legacy "most-recently-updated
  // town" branch on the server — which can target the wrong town and
  // chat with the wrong NPC. Single-town owners are unaffected.
  const viewerSlug = getActiveTownSlug();

  const { messages, sendMessage, status, error, stop } = useChat({
    transport: new DefaultChatTransport({
      // Default endpoint handles every regular NPC; special characters
      // (e.g. the Founder) opt into their own route via chat.chatApi.
      api: chat.chatApi ?? "/api/npc-chat",
      // Same body on every turn — the server reads npcId/mode/invitee
      // alongside the messages.
      body: {
        npcId: chat.npcId,
        mode: chat.mode ?? "direct",
        ...(chat.invitee ? { invitee: chat.invitee } : {}),
        ...(viewerSlug ? { townSlug: viewerSlug } : {}),
      },
    }),
  });

  // Keep the scroll pinned to the latest message as the stream lands
  // (and on mode swap so compact → expanded lands at the bottom too).
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, mode]);

  // ESC behaviour:
  // • expanded → drop back to compact so the player can still see
  // the modal without going full-screen.
  // • compact → close the chat (and abort any in-flight stream).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (mode === "expanded") {
        setMode("compact");
        return;
      }
      stop();
      ui.closeChat();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stop, mode]);

  const busy = status === "submitted" || status === "streaming";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage({ text });
    queueMicrotask(() => inputRef.current?.focus());
  };

  const controls = (
    <WindowControls
      mode={mode}
      onExpand={() => setMode("expanded")}
      onRestore={() => setMode("compact")}
      onClose={() => {
        stop();
        ui.closeChat();
      }}
    />
  );

  const isExpanded = mode === "expanded";
  const overlayCls = isExpanded
    ? "pointer-events-auto fixed inset-0 z-40 flex items-stretch justify-center bg-black/70 backdrop-blur-sm p-4 md:p-8"
    : "pointer-events-auto fixed inset-0 z-40 flex items-end justify-center bg-black/50 backdrop-blur-sm";
  const cardCls = isExpanded
    ? "relative flex w-full flex-col overflow-hidden border border-white/10 bg-[#0e1116] text-paper"
    : "relative m-4 flex w-full max-w-2xl flex-col overflow-hidden border border-white/10 bg-[#0e1116] text-paper";
  const innerCls = isExpanded
    ? "mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col"
    : "flex min-h-0 w-full flex-1 flex-col";

  return (
    <div className={overlayCls}>
      <div
        className={cardCls}
        role="dialog"
        aria-label={`Chat with ${chat.speaker}`}
      >
        <div className={innerCls}>
          {/* Header — quiet chrome, chunky avatar carries identity. */}
          <div className="flex items-center justify-between gap-4 border-b border-white/8 px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <div
                className="h-11 w-11 shrink-0 border border-white/10"
                style={{ background: chat.accent }}
                aria-hidden
              />
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-base font-black uppercase tracking-wide text-paper">
                  {chat.speaker}
                </span>
                <span className="text-[11px] font-bold uppercase tracking-wider text-paper/50">
                  {chat.mode === "invited" && chat.invitee
                    ? `with ${chat.invitee.name}`
                    : "in conversation"}
                </span>
              </div>
            </div>
            {controls}
          </div>

          {/* Transcript. */}
          <div
            ref={listRef}
            className={`flex flex-col gap-3 overflow-y-auto px-5 py-5 ${
              isExpanded ? "min-h-0 flex-1" : "max-h-[55vh] min-h-[220px]"
            }`}
          >
            <NpcBubble
              text={greeting}
              accent={chat.accent}
              expanded={isExpanded}
              isGreeting
            />
            {messages.map((m) => (
              <Bubble
                key={m.id}
                message={m}
                accent={chat.accent}
                expanded={isExpanded}
              />
            ))}
            {busy && messages[messages.length - 1]?.role !== "assistant" ? (
              <div className="flex items-center gap-2 pl-1 text-xs font-medium text-paper/50">
                <span className="inline-flex gap-1">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse bg-paper/60" />
                  <span
                    className="inline-block h-1.5 w-1.5 animate-pulse bg-paper/60"
                    style={{ animationDelay: "120ms" }}
                  />
                  <span
                    className="inline-block h-1.5 w-1.5 animate-pulse bg-paper/60"
                    style={{ animationDelay: "240ms" }}
                  />
                </span>
                {chat.speaker} is typing…
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="mx-5 mb-3 border-2 border-red-400/70 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">
              {error.message}
            </div>
          ) : null}

          {/* Composer. */}
          <form onSubmit={handleSubmit} className="flex gap-3 px-5 pb-5 pt-2">
            <div
              className="flex flex-1 items-center border border-white/15 bg-[color:var(--surface-raised)] px-4 py-2 focus-within:border-white/30 transition-colors duration-100"
              style={{ ["--surface-raised" as string]: SURFACE_RAISED }}
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={busy ? "…" : `Say something to ${chat.speaker}`}
                className={`w-full bg-transparent font-medium text-paper placeholder:text-paper/40 focus:outline-none ${
                  isExpanded ? "text-base" : "text-sm"
                }`}
                autoFocus
              />
            </div>
            <SendButton
              disabled={!input.trim() || busy}
              accent={chat.accent}
              expanded={isExpanded}
              label={busy ? "Sending" : "Send"}
            />
          </form>
        </div>
      </div>
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
      <IconButton onClick={onClose} title="Close" aria-label="Close chat">
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

function SendButton({
  disabled,
  accent,
  expanded,
  label,
}: {
  disabled: boolean;
  accent: string;
  expanded: boolean;
  label: string;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className={`shrink-0 border border-white/10 font-black uppercase tracking-wide text-ink transition-[opacity,background] duration-100 disabled:cursor-not-allowed disabled:opacity-50 ${
        expanded ? "px-5 py-3 text-sm" : "px-4 py-2.5 text-xs"
      }`}
      style={{ background: accent }}
    >
      {label}
    </button>
  );
}

function NpcBubble({
  text,
  accent,
  expanded,
  isGreeting,
}: {
  text: string;
  accent: string;
  expanded: boolean;
  isGreeting?: boolean;
}) {
  return (
    <div className="flex justify-start">
      <div
        className={`relative max-w-[80%] whitespace-pre-wrap break-words border border-white/10 bg-[#171a20] font-medium text-paper ${
          expanded
            ? "px-4 py-3 text-base leading-relaxed"
            : "px-3.5 py-2.5 text-sm leading-relaxed"
        }`}
      >
        {isGreeting ? (
          <span
            className="absolute -left-[2px] top-3 h-4 w-1.5 "
            style={{ background: accent }}
            aria-hidden
          />
        ) : null}
        {text}
      </div>
    </div>
  );
}

// One assistant card describing an item the NPC just handed over.
// `give_item` already persists the row and returns its id + label — we
// render the same SVG the modal uses, scaled down, and link to the
// public /items/[id] share page so a click feels like "open the card"
// without wiring a second modal route through the ui store.
interface ChatItemCardData {
  itemId: string;
  templateLabel: string;
}

interface TextRun {
  kind: "text";
  text: string;
}

interface ItemRun {
  kind: "item";
  card: ChatItemCardData;
}

type Run = TextRun | ItemRun;

// AI-SDK 6 types `tool-<name>` parts via a generic. We don't thread the
// tool surface through useChat, so the runtime shape gets a narrow
// guard here that picks out a successful give_item invocation.
function readGiveItemPart(part: { type: string }): ChatItemCardData | null {
  if (part.type !== "tool-give_item") return null;
  const raw = part as {
    state?: string;
    output?: unknown;
  };
  if (raw.state !== "output-available") return null;
  const output = raw.output;
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (o.ok !== true) return null;
  const itemId = typeof o.item_id === "string" ? o.item_id : null;
  if (!itemId) return null;
  const label =
    typeof o.template_label === "string" && o.template_label.length > 0
      ? o.template_label
      : typeof o.template_id === "string"
        ? o.template_id
        : "Item";
  return { itemId, templateLabel: label };
}

function collectRuns(message: UIMessage): Run[] {
  const runs: Run[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      const text = (part as { type: "text"; text: string }).text;
      if (text) runs.push({ kind: "text", text });
      continue;
    }
    const card = readGiveItemPart(part);
    if (card) runs.push({ kind: "item", card });
  }
  return runs;
}

function Bubble({
  message,
  accent,
  expanded,
}: {
  message: UIMessage;
  accent: string;
  expanded: boolean;
}) {
  const runs = collectRuns(message);
  if (runs.length === 0) return null;
  const isUser = message.role === "user";

  const textRuns = runs.filter((r): r is TextRun => r.kind === "text");
  const itemRuns = runs.filter((r): r is ItemRun => r.kind === "item");
  const joinedText = textRuns.map((r) => r.text).join("");

  return (
    <div
      className={`flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}
    >
      {joinedText ? (
        isUser ? (
          <div
            className={`max-w-[80%] whitespace-pre-wrap break-words border border-white/10 font-medium text-ink ${
              expanded
                ? "px-4 py-3 text-base leading-relaxed"
                : "px-3.5 py-2.5 text-sm leading-relaxed"
            }`}
            style={{ background: accent }}
          >
            {joinedText}
          </div>
        ) : (
          <div
            className={`max-w-[80%] whitespace-pre-wrap break-words border border-white/10 bg-[#171a20] font-medium text-paper ${
              expanded
                ? "px-4 py-3 text-base leading-relaxed"
                : "px-3.5 py-2.5 text-sm leading-relaxed"
            }`}
          >
            {joinedText}
          </div>
        )
      ) : null}
      {itemRuns.map((r) => (
        <ChatItemCard key={r.card.itemId} card={r.card} />
      ))}
    </div>
  );
}

function ChatItemCard({ card }: { card: ChatItemCardData }) {
  return (
    <a
      href={`/items/${card.itemId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="block max-w-[80%] overflow-hidden border border-white/10 bg-[#171a20] text-paper transition-colors duration-100"
      style={{ width: 320 }}
      aria-label={`Open ${card.templateLabel}`}
    >
      <div style={{ background: "#000", overflow: "hidden" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/items/${card.itemId}/svg`}
          alt={card.templateLabel}
          width={1200}
          height={630}
          style={{
            display: "block",
            width: "100%",
            height: "auto",
            aspectRatio: "1200 / 630",
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs font-black uppercase tracking-wide">
        <span className="truncate">Earned · {card.templateLabel}</span>
        <span className="text-paper/60">Open ↗</span>
      </div>
    </a>
  );
}
