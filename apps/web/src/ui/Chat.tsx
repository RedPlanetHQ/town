"use client";

// Streaming NPC chat overlay. Uses the AI-SDK `useChat` hook against
// /api/npc-chat. The system prompt is composed server-side from the
// NPC's row (Npc table or system-npcs/) plus the chat mode (direct vs
// invited). The route exposes a memory_search tool that hits CORE
// /api/v1/search with the user's PAT/access-token; we render only
// assistant text here — tool calls happen quietly behind the scenes.

import { useEffect, useRef, useState } from "react";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

import { getActiveTownSlug } from "../game/plotClient";
import { ui, type ChatState } from "./store";

export function Chat({ chat }: { chat: NonNullable<ChatState> }) {
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");

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

  // Keep the scroll pinned to the latest message as the stream lands.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ESC always closes the chat (and aborts any in-flight stream),
  // including from inside the text input — standard modal behaviour.
  // The earlier exemption that ignored ESC when the input had focus
  // meant the chat refused to close after the user typed anything,
  // which is exactly when they're most likely to press it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      stop();
      ui.closeChat();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stop]);

  const busy = status === "submitted" || status === "streaming";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage({ text });
    // Refocus the input — browsers sometimes drop focus to <body>
    // after a form submit, which leaves the user typing into the
    // overworld instead of the next reply. Defer to the next tick so
    // it runs after React's reconciliation.
    queueMicrotask(() => inputRef.current?.focus());
  };

  return (
    <div className="pointer-events-auto fixed inset-0 z-40 flex items-end justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="nb-card-dark m-4 flex w-full max-w-2xl flex-col gap-3 p-4"
        role="dialog"
        aria-label={`Chat with ${chat.speaker}`}
      >
        {/* Header — name + close. */}
        <div className="flex items-center justify-between gap-3 border-b-2 border-paper/15 pb-2">
          <div className="flex items-center gap-3">
            <div
              className="h-8 w-8 border-2 border-paper/20"
              style={{ background: chat.accent }}
              aria-hidden
            />
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-bold uppercase tracking-wider text-paper">
                {chat.speaker}
              </span>
              <span className="text-xs uppercase tracking-wider text-paper/60">
                {chat.mode === "invited" && chat.invitee
                  ? `with ${chat.invitee.name}`
                  : "in conversation"}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              stop();
              ui.closeChat();
            }}
            className="border-2 border-paper/30 px-2 py-1 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10"
            aria-label="Close chat"
          >
            ESC
          </button>
        </div>

        {/* Greeting + transcript. */}
        <div
          ref={listRef}
          className="flex max-h-[55vh] min-h-[180px] flex-col gap-2 overflow-y-auto pr-1"
        >
          <NpcGreeting accent={chat.accent} text={greeting} />
          {messages.map((m) => (
            <Bubble key={m.id} message={m} accent={chat.accent} />
          ))}
          {busy && messages[messages.length - 1]?.role !== "assistant" ? (
            <div className="text-xs italic text-paper/60">…</div>
          ) : null}
        </div>

        {error ? (
          <div className="border-2 border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error.message}
          </div>
        ) : null}

        {/* Input. */}
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={busy ? "..." : `Say something to ${chat.speaker}`}
            className="flex-1 border-2 border-paper/20 bg-black/30 px-3 py-2 text-sm text-paper placeholder:text-paper/40 focus:border-paper/50 focus:outline-none"
            autoFocus
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            className="border-2 border-paper/20 bg-paper px-3 py-2 text-xs font-bold uppercase tracking-wider text-ink disabled:opacity-40"
          >
            {busy ? "Sending" : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}

function NpcGreeting({ accent, text }: { accent: string; text: string }) {
  return (
    <div className="flex justify-start">
      <div
        className="max-w-[80%] whitespace-pre-wrap break-words border-2 border-paper/20 bg-black/30 px-3 py-2 text-sm leading-relaxed text-paper"
        style={{ borderLeft: `6px solid ${accent}` }}
      >
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
}: {
  message: UIMessage;
  accent: string;
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
        <div
          className="max-w-[80%] whitespace-pre-wrap break-words border-2 px-3 py-2 text-sm leading-relaxed"
          style={{
            background: isUser ? accent : "rgba(0,0,0,0.3)",
            color: isUser ? "var(--ink)" : "var(--paper)",
            borderColor: isUser ? accent : "rgba(246,243,234,0.2)",
          }}
        >
          {joinedText}
        </div>
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
      className="block max-w-[80%] border-2 border-paper/20 bg-black/40 p-2 text-paper shadow-[3px_3px_0_0_rgba(0,0,0,0.45)] hover:bg-black/30"
      style={{ width: 320 }}
      aria-label={`Open ${card.templateLabel}`}
    >
      <div
        style={{
          background: "#000",
          overflow: "hidden",
        }}
      >
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
      <div className="mt-2 flex items-center justify-between gap-2 text-xs font-bold uppercase tracking-wider">
        <span className="truncate">Earned · {card.templateLabel}</span>
        <span className="text-paper/60">Open ↗</span>
      </div>
    </a>
  );
}
