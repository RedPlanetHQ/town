"use client";

import { useEffect, useMemo, useState } from "react";

import { PALETTE } from "../game/config";
import { ui } from "./store";

// Invite modal — surfaced from the identity card dropdown's "Invite"
// action.
//
//   • Shows the town URL with `?invite_code=<code>` baked in so the
//     visitor lands on the gate with the code pre-filled.
//   • Also surfaces the raw code for users who'd rather paste it.
//   • Reset button mints a fresh code (invalidates the old one immediately).
//
// Slug + name come from the parent (TownGame). We previously fetched
// /api/towns/me here, but that returns the OLDEST owned town — so a
// multi-town owner viewing /{slug2} would get an invite for slug1.
// Threading the active slug down avoids the network call and the bug.
// The share-code endpoint is still hit on mount because the code lives
// on the Town row and can be rotated independently.
export interface InviteProps {
  townSlug: string;
  townName: string;
}

export function Invite({ townSlug, townName }: InviteProps) {
  const slug = townSlug;
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "url" | "code">("idle");
  const [error, setError] = useState<string | null>(null);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") ui.closeInvite();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const codeRes = await fetch(
          `/api/towns/${slug}/share-code`,
          { cache: "no-store" },
        );
        if (!codeRes.ok) {
          if (!cancelled) {
            setError("Couldn't load your share code.");
            setLoading(false);
          }
          return;
        }
        const codeBody = (await codeRes.json()) as { code: string };
        if (!cancelled) {
          setCode(codeBody.code);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError("Network error. Try again.");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const inviteUrl = useMemo(() => {
    if (!slug) return null;
    // Share links always point at the configured site host (default
    // town.getcore.me) so localhost / ngrok previews still generate
    // URLs the recipient can actually open. NEXT_PUBLIC_SITE_URL is
    // injected at build time.
    const origin =
      process.env.NEXT_PUBLIC_SITE_URL ?? "https://town.getcore.me";
    const base = `${origin}/${slug}`;
    return code ? `${base}?invite_code=${encodeURIComponent(code)}` : base;
  }, [slug, code]);

  async function rotateCode() {
    if (!slug) return;
    if (!confirm("Reset the share code? Anyone using the current code will lose access.")) {
      return;
    }
    setRotating(true);
    try {
      const res = await fetch(`/api/towns/${slug}/share-code`, {
        method: "POST",
      });
      if (!res.ok) {
        setError("Couldn't reset the code.");
      } else {
        const body = (await res.json()) as { code: string };
        setCode(body.code);
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setRotating(false);
    }
  }

  async function copy(text: string, kind: "url" | "code") {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState(kind);
      setTimeout(() => setCopyState("idle"), 1200);
    } catch {
      // Clipboard blocked — fall back to a quick prompt the user can copy from.
      prompt("Copy:", text);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) ui.closeInvite();
      }}
    >
      <div className="nb-card-dark flex w-full max-w-md flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-3 border-b-2 border-paper/15 pb-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-paper/60">
              Invite
            </div>
            <h2 className="mt-1 text-2xl font-black leading-tight text-paper">
              {townName}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => ui.closeInvite()}
            className="border-2 border-paper/30 px-2 py-1 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10"
            aria-label="Close invite"
          >
            ESC
          </button>
        </div>

        {loading ? (
          <div className="text-sm font-bold text-paper/60">
            Loading…
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-bold uppercase tracking-wide text-paper/60">
                Invite link
              </span>
              <div className="flex items-center justify-between gap-2 border-2 border-paper/20 bg-black/30 px-3 py-2">
                <span className="truncate text-sm font-bold text-paper">
                  {inviteUrl}
                </span>
                <button
                  type="button"
                  onClick={() => inviteUrl && void copy(inviteUrl, "url")}
                  className="text-xs font-bold uppercase tracking-wide text-paper/60 hover:text-paper"
                >
                  {copyState === "url" ? "Copied" : "Copy"}
                </button>
              </div>
              <span className="mt-1 text-xs text-paper/50">
                Anyone with this link lands on the gate with the code pre-filled.
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-bold uppercase tracking-wide text-paper/60">
                Share code
              </span>
              <div
                className="flex items-center justify-between gap-2 border-2 border-paper/20 px-3 py-3"
                style={{ background: PALETTE.h240 }}
              >
                <span className="font-mono text-2xl font-black tracking-[0.4em] text-ink">
                  {code ?? "------"}
                </span>
                <button
                  type="button"
                  onClick={() => code && void copy(code, "code")}
                  className="text-xs font-bold uppercase tracking-wide text-ink/70 hover:text-ink"
                >
                  {copyState === "code" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-xs text-paper/50">
                  Or paste this code into the gate manually.
                </span>
                <button
                  type="button"
                  onClick={() => void rotateCode()}
                  disabled={rotating}
                  className="text-xs font-bold uppercase tracking-wide text-paper/60 hover:text-paper disabled:opacity-40"
                >
                  {rotating ? "Resetting…" : "Reset code"}
                </button>
              </div>
            </div>

            {error ? (
              <div className="border-2 border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
