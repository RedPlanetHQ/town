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
// Fetches the slug + code on mount via /api/towns/me and
// /api/towns/{slug}/share-code. Both endpoints are owner-only — the menu
// itself is only mounted on the owner side, so unauthenticated callers
// shouldn't see this.
export function Invite() {
  const [slug, setSlug] = useState<string | null>(null);
  const [townName, setTownName] = useState<string | null>(null);
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
        const meRes = await fetch("/api/towns/me", { cache: "no-store" });
        if (!meRes.ok) {
          setError("Couldn't load your town. Try again.");
          setLoading(false);
          return;
        }
        const me = (await meRes.json()) as {
          town: { slug: string; name: string } | null;
        };
        if (!me.town) {
          setError("You don't have a town yet.");
          setLoading(false);
          return;
        }
        if (cancelled) return;
        setSlug(me.town.slug);
        setTownName(me.town.name);

        const codeRes = await fetch(
          `/api/towns/${me.town.slug}/share-code`,
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
  }, []);

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
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) ui.closeInvite();
      }}
    >
      <div className="nb-card flex w-full max-w-md flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-ink opacity-60">
              Invite
            </div>
            <h2 className="mt-1 text-2xl font-black leading-tight text-ink">
              {townName ?? "Your town"}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => ui.closeInvite()}
            className="text-xs font-bold uppercase tracking-wide text-ink opacity-60 hover:opacity-100"
          >
            Close
          </button>
        </div>

        {loading ? (
          <div className="text-sm font-bold text-ink opacity-60">
            Loading…
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-bold uppercase tracking-wide text-ink opacity-60">
                Invite link
              </span>
              <div className="nb-tile flex items-center justify-between gap-2 bg-paper px-3 py-2">
                <span className="truncate text-sm font-bold text-ink">
                  {inviteUrl}
                </span>
                <button
                  type="button"
                  onClick={() => inviteUrl && void copy(inviteUrl, "url")}
                  className="text-xs font-bold uppercase tracking-wide text-ink opacity-60 hover:opacity-100"
                >
                  {copyState === "url" ? "Copied" : "Copy"}
                </button>
              </div>
              <span className="mt-1 text-[11px] text-ink opacity-60">
                Anyone with this link lands on the gate with the code pre-filled.
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-bold uppercase tracking-wide text-ink opacity-60">
                Share code
              </span>
              <div
                className="nb-tile flex items-center justify-between gap-2 px-3 py-3"
                style={{ background: PALETTE.h240 }}
              >
                <span className="font-mono text-2xl font-black tracking-[0.4em] text-ink">
                  {code ?? "------"}
                </span>
                <button
                  type="button"
                  onClick={() => code && void copy(code, "code")}
                  className="text-xs font-bold uppercase tracking-wide text-ink opacity-60 hover:opacity-100"
                >
                  {copyState === "code" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-[11px] text-ink opacity-60">
                  Or paste this code into the gate manually.
                </span>
                <button
                  type="button"
                  onClick={() => void rotateCode()}
                  disabled={rotating}
                  className="text-xs font-bold uppercase tracking-wide text-ink opacity-60 hover:opacity-100"
                >
                  {rotating ? "Resetting…" : "Reset code"}
                </button>
              </div>
            </div>

            {error ? (
              <div className="text-sm font-bold" style={{ color: "var(--destructive)" }}>
                {error}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
