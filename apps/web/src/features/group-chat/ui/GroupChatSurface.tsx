"use client";

// Bottom-right non-modal overlay. Renders only when the store says
// `open` is true. The game keeps running underneath — this is
// deliberately NOT in ui.isPaused() so the player can walk while the
// panel is up.
//
// Visual language matches the existing Chat / Panel surfaces
// (paper background, 2px ink border, h240 accent for the local
// player's bubbles).

import { useEffect, useMemo, useRef, useState } from "react";

import { useGroupChatState } from "../client/useGroupChatState";
import { closeRoom, postMessage, publishTyping } from "../client/channel";
import { authorColor } from "./authorColor";

export function GroupChatSurface() {
  const state = useGroupChatState();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");

  // Keep the list pinned to the bottom on new messages / typing
  // changes. Same pattern as Chat.tsx.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state.messages, state.typing]);

  // Focus the input the moment the overlay opens so the player can
  // type immediately without clicking.
  useEffect(() => {
    if (!state.open) return;
    inputRef.current?.focus();
  }, [state.open]);

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
    return Array.from(state.typing.values())
      .map((t) => t.authorName)
      .filter((n) => !!n);
  }, [state.typing]);

  if (!state.open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    void postMessage(text);
    // Refocus after submit — Chrome sometimes drops focus to body.
    queueMicrotask(() => inputRef.current?.focus());
  };

  const ownerKey = state.room?.ownerParticipantKey ?? "";

  return (
    <div className="pointer-events-auto fixed bottom-4 right-4 z-30 flex w-[360px] flex-col gap-2 rounded-md border-2 border-ink bg-paper p-3 shadow-[6px_6px_0_0_#1a1d22]">
      <div className="flex items-center justify-between gap-2 border-b-2 border-ink pb-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink">
            Group chat
          </span>
          {state.room ? (
            <span className="text-[10px] uppercase tracking-wider text-ink opacity-60">
              · {state.room.buildingLabel}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void closeRoom()}
          className="border-2 border-ink bg-paper px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink hover:bg-ink hover:text-paper"
          aria-label="Close group chat (G or ESC)"
          title="Close (G or ESC)"
        >
          ESC
        </button>
      </div>

      <div
        ref={listRef}
        className="flex max-h-[40vh] min-h-[160px] flex-col gap-1.5 overflow-y-auto pr-1"
      >
        {state.status === "loading" ? (
          <div className="text-[11px] italic opacity-60">Connecting…</div>
        ) : null}
        {state.status === "error" ? (
          <div className="text-[11px] italic text-red-700">
            {state.errorMessage || "Something went wrong"}
          </div>
        ) : null}
        {state.status === "ready" && state.messages.length === 0 ? (
          <div className="text-[11px] italic opacity-60">
            No messages yet — say hi.
          </div>
        ) : null}
        {state.messages.map((m) => (
          <MessageLine key={m.id} m={m} ownerKey={ownerKey} />
        ))}
      </div>

      {typingNames.length > 0 ? (
        <div className="text-[11px] italic leading-tight text-ink opacity-70">
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
          placeholder="Say something to the room"
          className="flex-1 border-2 border-ink bg-white px-2 py-1 text-[13px] text-ink focus:outline-none"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="border-2 border-ink bg-ink px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-paper disabled:opacity-40"
        >
          Send
        </button>
      </form>
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
    <div className="text-[13px] leading-snug text-ink">
      <span
        className="mr-1 font-bold"
        style={{ color: authorColor(m.authorKey) }}
      >
        {m.authorName}
        {isOwner ? (
          <span className="ml-1 text-[10px] font-bold uppercase tracking-wider opacity-60">
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
