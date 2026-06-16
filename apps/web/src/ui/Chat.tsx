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

import { getViewerTownSlug } from "../game/plotClient";
import { ui, type ChatState } from "./store";

export function Chat({ chat }: { chat: NonNullable<ChatState> }) {
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");

  // Greeting message shown above the input on first paint so the player
  // sees who they're talking to before the LLM streams its first turn.
  const greeting = `Hi, I'm ${chat.speaker}. ${chat.description}`.trim();

  // When the player is touring someone else's town, the chat needs to
  // resolve NPCs against THAT town's owner (not the caller). Sending
  // the slug along with every message lets the server use the
  // resolveViewer helper to swap identity context: NPC lookup uses the
  // town owner, but the prompt knows the speaker is a visitor.
  const viewerSlug = getViewerTownSlug();

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
    <div className="pointer-events-auto fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-sm">
      <div
        className="m-4 flex w-full max-w-2xl flex-col gap-3 rounded-md border-2 border-ink bg-paper p-4 shadow-[6px_6px_0_0_#1a1d22]"
        role="dialog"
        aria-label={`Chat with ${chat.speaker}`}
      >
        {/* Header — name + close. */}
        <div className="flex items-center justify-between gap-3 border-b-2 border-ink pb-2">
          <div className="flex items-center gap-3">
            <div
              className="h-9 w-9 border-2 border-ink text-base font-black"
              style={{ background: chat.accent }}
              aria-hidden
            />
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-bold uppercase tracking-wider text-ink">
                {chat.speaker}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-ink opacity-60">
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
            className="border-2 border-ink bg-paper px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-ink hover:bg-ink hover:text-paper"
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
            <div className="text-[11px] italic opacity-60">…</div>
          ) : null}
        </div>

        {error ? (
          <div className="border-2 border-red-700 bg-red-50 px-3 py-2 text-[12px] text-red-900">
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
            className="flex-1 border-2 border-ink bg-white px-3 py-2 text-[14px] text-ink focus:outline-none"
            autoFocus
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            className="border-2 border-ink bg-ink px-3 py-2 text-[12px] font-bold uppercase tracking-wider text-paper disabled:opacity-40"
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
        className="max-w-[80%] whitespace-pre-wrap break-words rounded-md border-2 border-ink bg-white px-3 py-2 text-[14px] leading-relaxed text-ink"
        style={{ borderLeft: `6px solid ${accent}` }}
      >
        {text}
      </div>
    </div>
  );
}

function Bubble({
  message,
  accent,
}: {
  message: UIMessage;
  accent: string;
}) {
  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  if (!text) return null;
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className="max-w-[80%] whitespace-pre-wrap break-words rounded-md border-2 border-ink px-3 py-2 text-[14px] leading-relaxed"
        style={{
          background: isUser ? accent : "#ffffff",
          color: "var(--ink)",
        }}
      >
        {text}
      </div>
    </div>
  );
}
