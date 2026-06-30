"use client";

import { useEffect, useMemo, useState } from "react";

import { PALETTE } from "../game/config";
import { ui } from "./store";

// Share-image modal — surfaced from the identity card dropdown's "Share"
// action.
//
//   • Loads the server-rendered postcard from
//     /api/towns/<slug>/postcard.png. Same 1200×628 PNG that powers
//     the og:image / twitter:image meta tags, so the preview here
//     matches what social-card scrapers see.
//   • Share targets: Copy link, Download, native Share (Web Share API
//     with the PNG file when supported), X, LinkedIn, WhatsApp.
//
// Image attachment, per-target reality:
//   • Native Share — attaches the PNG when the browser exposes
//     `navigator.share({ files })` (most mobile + Chrome / Safari on
//     desktop). Falls back to text + URL when it doesn't.
//   • X / LinkedIn / WhatsApp deep links can only carry text + URL —
//     no public intent accepts an attached file. Their link previews
//     come from the page's OG card (which is the same image), so the
//     postcard still shows up at the destination.
//
// Slug + name come from the parent (TownGame) so multi-town owners
// share the town they're currently viewing. The previous /api/towns/me
// path returned the OLDEST owned town — wrong for multi-town owners.
export interface ShareImageProps {
  townSlug: string;
  townName: string;
}

export function ShareImage({ townSlug, townName }: ShareImageProps) {
  const slug = townSlug;
  const [code, setCode] = useState<string | null>(null);
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [imageObjectUrl, setImageObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") ui.closeShareImage();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Single mount-time effect: fetch share code → postcard PNG. We hold
  // the blob so Download + native Share can pass a File payload, and
  // an object URL so the <img> can paint without a base64 round-trip.
  useEffect(() => {
    let cancelled = false;
    let createdObjectUrl: string | null = null;
    (async () => {
      try {
        // Share code — best effort. The buttons still work without it
        // (URL just lacks the prefill query param).
        try {
          const codeRes = await fetch(
            `/api/towns/${slug}/share-code`,
            { cache: "no-store" },
          );
          if (codeRes.ok) {
            const body = (await codeRes.json()) as { code: string };
            if (!cancelled) setCode(body.code);
          }
        } catch {
          // ignore
        }

        // Postcard PNG. Cache-bust so the modal always shows the
        // latest plot — the server endpoint sends cache headers for
        // the social bots, we don't want the modal to surface stale.
        const png = await fetch(
          `/api/towns/${slug}/postcard.png?t=${Date.now()}`,
          { cache: "no-store" },
        );
        if (!png.ok) {
          if (!cancelled) {
            setError("Couldn't render your postcard.");
            setLoading(false);
          }
          return;
        }
        const blob = await png.blob();
        if (cancelled) return;
        createdObjectUrl = URL.createObjectURL(blob);
        setImageBlob(blob);
        setImageObjectUrl(createdObjectUrl);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError("Network error. Try again.");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
    };
  }, [slug]);

  const shareUrl = useMemo(() => {
    if (!slug) return null;
    // Share targets always point at the configured site host (default
    // town.getcore.me) so localhost / ngrok previews still generate
    // URLs the recipient can actually open.
    const origin =
      process.env.NEXT_PUBLIC_SITE_URL ?? "https://town.getcore.me";
    const base = `${origin}/${slug}`;
    return code ? `${base}?invite_code=${encodeURIComponent(code)}` : base;
  }, [slug, code]);

  const shareText = useMemo(() => {
    const town = townName ?? "my CORE town";
    return `Come hang out in ${town}`;
  }, [townName]);

  // Native Share API is available in modern mobile browsers and Chrome
  // / Safari on desktop. We probe at render time so the button only
  // shows up when the browser can actually fulfil the call.
  const canNativeShare = useMemo(() => {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function"
    );
  }, []);

  function imageFile(): File | null {
    if (!imageBlob) return null;
    return new File([imageBlob], `${slug ?? "town"}.png`, {
      type: imageBlob.type || "image/png",
    });
  }

  function downloadImage() {
    if (!imageObjectUrl) return;
    const a = document.createElement("a");
    a.href = imageObjectUrl;
    a.download = `${slug ?? "town"}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function copyLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      prompt("Copy:", shareUrl);
    }
  }

  async function nativeShare() {
    if (!shareUrl) return;
    const file = imageFile();
    try {
      if (
        file &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [file] })
      ) {
        await navigator.share({
          title: townName ?? "My town",
          text: shareText,
          url: shareUrl,
          files: [file],
        });
        return;
      }
      await navigator.share({
        title: townName ?? "My town",
        text: shareText,
        url: shareUrl,
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError("Share sheet unavailable — try another option.");
      }
    }
  }

  function openTwitter() {
    if (!shareUrl) return;
    const intent =
      "https://twitter.com/intent/tweet" +
      `?text=${encodeURIComponent(shareText)}` +
      `&url=${encodeURIComponent(shareUrl)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
  }

  function openLinkedIn() {
    if (!shareUrl) return;
    const intent =
      "https://www.linkedin.com/sharing/share-offsite/" +
      `?url=${encodeURIComponent(shareUrl)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
  }

  function openWhatsApp() {
    if (!shareUrl) return;
    const intent =
      "https://wa.me/?text=" + encodeURIComponent(`${shareText} ${shareUrl}`);
    window.open(intent, "_blank", "noopener,noreferrer");
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) ui.closeShareImage();
      }}
    >
      <div className="nb-card-dark flex w-full max-w-xl flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-3 border-b-2 border-paper/15 pb-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-paper/60">
              Share
            </div>
            <h2 className="mt-1 text-2xl font-black leading-tight text-paper">
              {townName ?? "Your town"}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => ui.closeShareImage()}
            className="border-2 border-paper/30 px-2 py-1 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10"
            aria-label="Close share"
          >
            ESC
          </button>
        </div>

        <div
          className="flex aspect-[1200/628] w-full items-center justify-center overflow-hidden border-2 border-paper/20 bg-black/40"
        >
          {loading ? (
            <span className="text-xs font-bold uppercase tracking-wide text-paper/60">
              Rendering postcard…
            </span>
          ) : imageObjectUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageObjectUrl}
              alt={`${townName ?? "Town"} postcard`}
              className="h-full w-full object-contain"
              style={{ imageRendering: "pixelated" }}
            />
          ) : (
            <span className="text-xs font-bold uppercase tracking-wide text-red-300">
              Render failed
            </span>
          )}
        </div>

        <div
          className={`grid gap-2 ${canNativeShare ? "grid-cols-6" : "grid-cols-5"}`}
        >
          <ShareButton
            label={copied ? "Copied" : "Copy link"}
            background={PALETTE.h240}
            disabled={!shareUrl}
            onClick={() => void copyLink()}
            icon={CopyIcon}
          />
          <ShareButton
            label="Download"
            background={PALETTE.h180}
            disabled={!imageObjectUrl}
            onClick={() => downloadImage()}
            icon={DownloadIcon}
          />
          {canNativeShare ? (
            <ShareButton
              label="Share"
              background={PALETTE.h120}
              disabled={!shareUrl}
              onClick={() => void nativeShare()}
              icon={ShareIcon}
            />
          ) : null}
          <ShareButton
            label="X"
            background={PALETTE.h210}
            disabled={!shareUrl}
            onClick={() => openTwitter()}
            icon={XIcon}
          />
          <ShareButton
            label="LinkedIn"
            background={PALETTE.h270}
            disabled={!shareUrl}
            onClick={() => openLinkedIn()}
            icon={LinkedInIcon}
          />
          <ShareButton
            label="WhatsApp"
            background={PALETTE.h150}
            disabled={!shareUrl}
            onClick={() => openWhatsApp()}
            icon={WhatsAppIcon}
          />
        </div>

        <p className="text-xs leading-snug text-paper/50">
          {canNativeShare
            ? "Share uses your device's share sheet and attaches the PNG when supported. X, LinkedIn and WhatsApp open with the invite link — their previews pick up this same image from the page meta tags."
            : "X, LinkedIn and WhatsApp open with the invite link prefilled — their previews pick up this same image from the page meta tags."}
        </p>

        {error ? (
          <div className="border-2 border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ShareButton({
  label,
  background,
  disabled,
  onClick,
  icon: Icon,
}: {
  label: string;
  background: string;
  disabled: boolean;
  onClick: () => void;
  icon: () => React.ReactElement;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="nb-tile flex flex-col items-center justify-center gap-1 px-2 py-2 text-[10px] font-black uppercase tracking-wide"
      style={{
        background,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span className="flex h-5 w-5 items-center justify-center text-ink">
        <Icon />
      </span>
      <span className="text-ink">{label}</span>
    </button>
  );
}

// Small inline icons — kept as SVG components so they pick up the
// surrounding text colour and stay crisp at any size. Stroke width is
// chunky to match the neobrutalism panel borders.

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      width="100%"
      height="100%"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="6" y="6" width="11" height="11" rx="1.5" />
      <path d="M4 13V4.5C4 4 4.5 3.5 5 3.5h8.5" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      width="100%"
      height="100%"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 3v10" />
      <path d="M5 9l5 5 5-5" />
      <path d="M4 17h12" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      width="100%"
      height="100%"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="5" cy="10" r="2.2" />
      <circle cx="15" cy="5" r="2.2" />
      <circle cx="15" cy="15" r="2.2" />
      <path d="M7 9l6-3" />
      <path d="M7 11l6 3" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 20 20" width="100%" height="100%" fill="currentColor">
      <path d="M14.5 3h2.3l-5.1 5.8L18 17h-4.7l-3.7-4.8L5.5 17H3.2l5.4-6.2L3 3h4.8l3.4 4.4L14.5 3zm-.8 12.3h1.3L6.4 4.6H5L13.7 15.3z" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg viewBox="0 0 20 20" width="100%" height="100%" fill="currentColor">
      <path d="M16.5 16.5h-2.6V12c0-1.1-.4-1.8-1.4-1.8-.8 0-1.2.5-1.4 1-.1.2-.1.5-.1.7v4.6H8.4S8.5 8.8 8.4 8h2.6v1.1c.3-.5 1-1.3 2.4-1.3 1.8 0 3.1 1.1 3.1 3.6v5.1zM5.7 6.9h0c-.9 0-1.4-.6-1.4-1.3 0-.7.5-1.3 1.4-1.3.9 0 1.4.6 1.4 1.3 0 .7-.5 1.3-1.4 1.3zM4.4 16.5h2.6V8H4.4v8.5z" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 20 20" width="100%" height="100%" fill="currentColor">
      <path d="M10 2.5c-4.1 0-7.5 3.3-7.5 7.4 0 1.3.4 2.6 1 3.7l-1.1 4 4.1-1.1c1.1.6 2.3.9 3.5.9 4.1 0 7.5-3.3 7.5-7.5S14.1 2.5 10 2.5zm0 13.6c-1.1 0-2.2-.3-3.1-.9l-.2-.1-2.4.6.6-2.4-.1-.2c-.6-1-.9-2.1-.9-3.2 0-3.4 2.8-6.1 6.1-6.1s6.1 2.8 6.1 6.1c0 3.4-2.8 6.2-6.1 6.2zm3.4-4.6c-.2-.1-1.1-.5-1.2-.6-.2-.1-.3-.1-.4.1s-.5.6-.6.7c-.1.1-.2.1-.4 0-.2-.1-.8-.3-1.5-.9-.6-.5-.9-1.1-1.1-1.3-.1-.2 0-.3.1-.4l.3-.3c.1-.1.1-.2.2-.4 0-.1 0-.3 0-.4 0-.1-.4-1-.5-1.3-.1-.4-.3-.3-.4-.3h-.4c-.1 0-.4.1-.6.3s-.8.7-.8 1.8c0 1.1.8 2 .9 2.2.1.2 1.5 2.4 3.7 3.3.5.2.9.4 1.2.4.5.2 1 .1 1.3.1.4 0 1.1-.5 1.3-.9.2-.5.2-.8.1-.9-.1-.1-.2-.2-.4-.2z" />
    </svg>
  );
}
