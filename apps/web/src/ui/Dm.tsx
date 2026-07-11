"use client";

import { useEffect, useRef, useState } from "react";
import { Centrifuge, type PublicationContext } from "centrifuge";

import { PALETTE } from "../game/config";
import { CloseIcon, ExpandIcon, RestoreIcon } from "./chat-icons";
import { ui } from "./store";

// DM compose panel.
//
// Opens when ui.state.dm is set (via SPACE on a proximity target or by
// clicking a pending pill). Loads conversation history from the server,
// subscribes to the Centrifugo DM channel for live updates, and posts
// new messages via /api/towns/[slug]/dm/[other].
//
// Visual language matches Chat.tsx — flat rectangles, subtle
// white/10 hairline borders, one accent voice (h240 blue for the
// viewer's own bubbles + the SEND button). Two window modes: compact
// bottom-right dock and expanded near-full-screen for chattier reads.

type Message = {
  id: string;
  fromKey: string;
  text: string;
  createdAt: string;
};

type LoadResponse = {
  conversationId: string | null;
  viewerKey: string;
  otherKey: string;
  pendingFromKey: string | null;
  messages: Message[];
};

type WindowMode = "compact" | "expanded";

const SURFACE_RAISED = "#171a20";
const OTHER_BUBBLE_BG = "#171a20";

export function Dm({
  townSlug,
  otherKey,
  otherName,
}: {
  townSlug: string;
  otherKey: string;
  otherName: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<WindowMode>("compact");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Esc closes the panel — except in expanded mode where it collapses
  // back to compact so a player mid-scroll doesn't lose context.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (mode === "expanded") {
        e.preventDefault();
        e.stopPropagation();
        setMode("compact");
        return;
      }
      ui.closeDm();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode]);

  // Initial fetch + live subscription.
  useEffect(() => {
    let cancelled = false;
    let centrifuge: Centrifuge | null = null;
    let sub: ReturnType<Centrifuge["newSubscription"]> | null = null;

    (async () => {
      try {
        const res = await fetch(
          `/api/towns/${townSlug}/dm/${encodeURIComponent(otherKey)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          setError("Couldn't load the conversation.");
          setLoading(false);
          return;
        }
        const body = (await res.json()) as LoadResponse;
        if (cancelled) return;
        setMessages(body.messages);
        setViewerKey(body.viewerKey);
        setLoading(false);

        const connRes = await fetch(`/api/towns/${townSlug}/realtime-token`, {
          cache: "no-store",
        });
        if (!connRes.ok) return;
        const conn = (await connRes.json()) as {
          token: string;
          url: string;
        };
        if (!conn.url) return;
        const tokenRes = await fetch(
          `/api/towns/${townSlug}/dm/${encodeURIComponent(otherKey)}/subscribe-token`,
          { cache: "no-store" },
        );
        if (!tokenRes.ok) return;
        const { token, channel } = (await tokenRes.json()) as {
          token: string;
          channel: string;
        };
        if (cancelled) return;
        centrifuge = new Centrifuge(conn.url, { token: conn.token });
        sub = centrifuge.newSubscription(channel, { token });
        sub.on("publication", (ctx: PublicationContext) => {
          const m = ctx.data as Message;
          if (!m || !m.id) return;
          setMessages((prev) => {
            if (prev.some((p) => p.id === m.id)) return prev;
            return [...prev, m];
          });
        });
        sub.subscribe();
        centrifuge.connect();
      } catch {
        if (!cancelled) {
          setError("Network error.");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      sub?.unsubscribe();
      centrifuge?.disconnect();
    };
  }, [townSlug, otherKey]);

  // Auto-scroll to the latest message on new messages and on mode swap
  // so the bottom stays pinned when compact → expanded.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, mode]);

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/towns/${townSlug}/dm/${encodeURIComponent(otherKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        },
      );
      if (!res.ok) {
        setError("Couldn't send. Try again.");
      } else {
        const { message } = (await res.json()) as { message: Message };
        setMessages((prev) =>
          prev.some((p) => p.id === message.id) ? prev : [...prev, message],
        );
        setDraft((cur) => (cur.trim() === text ? "" : cur));
      }
    } catch {
      setError("Network error.");
    } finally {
      setSending(false);
      // When the player clicks Send (instead of pressing Enter), focus
      // moves to the button — return it to the input so they don't
      // have to reach for the mouse to type the next message.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  const isExpanded = mode === "expanded";
  const wrapper = isExpanded
    ? "fixed inset-4 z-40 flex flex-col md:inset-8"
    : "fixed bottom-12 right-4 z-40 flex w-full max-w-sm flex-col";
  const wrapperStyle: React.CSSProperties = isExpanded
    ? {}
    : { maxHeight: "70vh" };
  const cardCls = isExpanded
    ? "relative flex flex-1 flex-col overflow-hidden border border-white/10 bg-[#0e1116] text-paper"
    : "relative flex flex-1 flex-col overflow-hidden border border-white/10 bg-[#0e1116] text-paper";
  const innerCls = isExpanded
    ? "mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col"
    : "flex min-h-0 w-full flex-1 flex-col";

  return (
    <div className={wrapper} style={wrapperStyle}>
      <div className={cardCls}>
        <div className={innerCls}>
          <div className="flex items-center justify-between gap-4 border-b border-white/8 px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <div
                className="h-11 w-11 shrink-0 border border-white/10"
                style={{ background: PALETTE.h240 }}
                aria-hidden
              />
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="text-[11px] font-bold uppercase tracking-wider text-paper/50">
                  Talking to
                </span>
                <span className="truncate text-base font-black uppercase tracking-wide text-paper">
                  {otherName}
                </span>
              </div>
            </div>
            <WindowControls
              mode={mode}
              onExpand={() => setMode("expanded")}
              onRestore={() => setMode("compact")}
              onClose={() => ui.closeDm()}
            />
          </div>

          <div
            ref={scrollRef}
            className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-5"
            style={{
              minHeight: isExpanded ? "0" : "12rem",
              maxHeight: isExpanded ? "none" : "40vh",
            }}
          >
            {loading ? (
              <div className="text-xs font-bold uppercase tracking-wider text-paper/50">
                Loading…
              </div>
            ) : messages.length === 0 ? (
              <div className="text-xs font-bold uppercase tracking-wider text-paper/50">
                Say hi to start the conversation.
              </div>
            ) : (
              messages.map((m) => {
                const mine = m.fromKey === viewerKey;
                const stamp = formatMessageTime(m.createdAt);
                return (
                  <div
                    key={m.id}
                    className={
                      "flex flex-col gap-1 " +
                      (mine ? "items-end" : "items-start")
                    }
                  >
                    <div
                      className={`max-w-[80%] whitespace-pre-wrap break-words border border-white/10 font-medium ${
                        mine ? "" : ""
                      } ${
                        isExpanded
                          ? "px-4 py-3 text-base leading-relaxed"
                          : "px-3.5 py-2.5 text-sm leading-relaxed"
                      }`}
                      style={{
                        background: mine ? PALETTE.h240 : OTHER_BUBBLE_BG,
                        color: mine ? "var(--ink)" : "var(--paper)",
                      }}
                    >
                      {m.text}
                    </div>
                    {isExpanded && stamp ? (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-paper/40">
                        {stamp}
                      </span>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          <div className="flex items-center gap-3 px-5 pb-5 pt-2">
            <div
              className="flex flex-1 items-center border border-white/15 bg-[color:var(--surface-raised)] px-4 py-2 focus-within:border-white/30 transition-colors duration-100"
              style={{ ["--surface-raised" as string]: SURFACE_RAISED }}
            >
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !sending) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Say something…"
                maxLength={2000}
                className={`w-full bg-transparent font-medium text-paper placeholder:text-paper/40 focus:outline-none ${
                  isExpanded ? "text-base" : "text-sm"
                }`}
                autoFocus
              />
            </div>
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || draft.trim().length === 0}
              className={`shrink-0 border border-white/10 font-black uppercase tracking-wide text-ink transition-[opacity,background] duration-100 disabled:cursor-not-allowed disabled:opacity-50 ${
                isExpanded ? "px-5 py-3 text-sm" : "px-4 py-2.5 text-xs"
              }`}
              style={{ background: PALETTE.h240 }}
            >
              Send
            </button>
          </div>

          {error ? (
            <div className="mx-5 mb-4 border-2 border-red-400/70 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">
              {error}
            </div>
          ) : null}
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

function formatMessageTime(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
