"use client";

import { useEffect, useRef, useState } from "react";
import { Centrifuge, type PublicationContext } from "centrifuge";

import { PALETTE } from "../game/config";
import { ui } from "./store";

// DM compose panel.
//
// Opens when ui.state.dm is set (via SPACE on a proximity target or by
// clicking a pending pill). Loads conversation history from the server,
// subscribes to the Centrifugo DM channel for live updates, and posts
// new messages via /api/towns/[slug]/dm/[other].
//
// Closes on Esc / Close button / explicit ui.closeDm() from another
// surface. No auto-close on walk-away yet — the user said the panel is
// expected to persist while it's open.

type Message = {
  id: string;
  fromKey: string;
  text: string;
  createdAt: string;
};

type LoadResponse = {
  // Null when the conversation hasn't been opened yet on the server.
  // The first POST upserts a row and subsequent loads will return a
  // string here.
  conversationId: string | null;
  viewerKey: string;
  otherKey: string;
  pendingFromKey: string | null;
  messages: Message[];
};

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Esc closes the panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") ui.closeDm();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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

        // Live subscribe. We re-use the realtime-token endpoint to learn
        // both the WebSocket URL and the connection JWT — that way the
        // browser never depends on a build-time env var.
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

  // Auto-scroll to the latest message.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

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
        // Optimistic add — Centrifugo will also broadcast it but we
        // dedupe by id.
        setMessages((prev) =>
          prev.some((p) => p.id === message.id) ? prev : [...prev, message],
        );
        // Only clear the draft if the player hasn't started a new
        // message since they hit send. The input stays enabled during
        // the round-trip so they can keep typing; we don't want to
        // wipe what they just typed.
        setDraft((cur) => (cur.trim() === text ? "" : cur));
      }
    } catch {
      setError("Network error.");
    } finally {
      setSending(false);
      // When the player clicks Send (instead of pressing Enter), focus
      // moves to the button — return it to the input so they don't
      // have to reach for the mouse to type the next message. rAF
      // defers until after React commits the post-send state.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  return (
    <div
      className="fixed bottom-4 right-4 z-40 flex w-full max-w-sm flex-col"
      style={{ maxHeight: "70vh" }}
    >
      <div className="nb-card flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b-2 border-ink px-3 py-2">
          <div className="flex flex-col">
            <div className="text-[10px] font-bold uppercase tracking-wide text-ink opacity-60">
              Talking to
            </div>
            <div className="text-sm font-bold leading-tight text-ink">
              {otherName}
            </div>
          </div>
          <button
            type="button"
            onClick={() => ui.closeDm()}
            className="text-xs font-bold uppercase tracking-wide text-ink opacity-60 hover:opacity-100"
          >
            Close
          </button>
        </div>

        <div
          ref={scrollRef}
          className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2"
          style={{ minHeight: "12rem", maxHeight: "40vh" }}
        >
          {loading ? (
            <div className="text-xs font-bold text-ink opacity-60">
              Loading…
            </div>
          ) : messages.length === 0 ? (
            <div className="text-xs font-bold text-ink opacity-60">
              Say hi to start the conversation.
            </div>
          ) : (
            messages.map((m) => {
              const mine = m.fromKey === viewerKey;
              return (
                <div
                  key={m.id}
                  className={
                    "nb-tile max-w-[80%] px-2 py-1 text-xs font-bold text-ink " +
                    (mine ? "self-end" : "self-start")
                  }
                  style={{
                    background: mine ? PALETTE.h240 : PALETTE.h60,
                  }}
                >
                  {m.text}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-2 border-t-2 border-ink px-3 py-2">
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
            className="nb-tile flex-1 bg-paper px-2 py-1 text-sm font-bold text-ink outline-none"
            // Intentionally NOT disabled while sending. Browsers blur a
            // disabled input, which kills focus mid-round-trip. The
            // Enter handler + Send button both gate on `sending`, so
            // double-submit is already prevented.
            autoFocus
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || draft.trim().length === 0}
            className="nb-tile px-3 py-1 text-xs font-black uppercase tracking-wide"
            style={{
              background: draft.trim() ? PALETTE.h240 : "#a4afbd",
              cursor:
                draft.trim() && !sending ? "pointer" : "not-allowed",
              opacity: sending ? 0.6 : 1,
            }}
          >
            Send
          </button>
        </div>

        {error ? (
          <div
            className="border-t-2 border-ink px-3 py-1 text-xs font-bold"
            style={{ color: "var(--destructive)" }}
          >
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
