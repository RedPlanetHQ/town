"use client";

// Small bottom-right toast that fires when the player enters a town.
// Shows an animated ink stamp for the town, a "Download passport" link,
// and self-dismisses after ~5 seconds. Purely cosmetic — the actual
// passport stamp is written on the server; this just celebrates the
// entry with a delightful nudge to the passport.

import { useEffect, useMemo, useState } from "react";

// Same palette used by the SVG renderer; kept in sync manually since the
// server module and this client module can't share the .ts file safely.
const STAMP_COLORS = [
  "#4a7f3f", "#8b3030", "#3a6ea5", "#c46b1e",
  "#5a4d8a", "#2f6e6a", "#8a5a1e", "#7a2e6a",
];

function hashSlug(slug: string): number {
  let h = 5381;
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h + slug.charCodeAt(i)) >>> 0;
  return h;
}

// Sits above the 28px BottomBar + a small breathing gap so the toast
// isn't clipped by the "TOWN ACTIVITY" strip along the bottom edge.
const TOAST_BOTTOM_PX = 44;

export function PassportStampToast({
  townSlug,
  townName,
  autoDismissMs = 12000,
}: {
  townSlug: string;
  townName: string;
  autoDismissMs?: number;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setVisible(false), autoDismissMs);
    return () => clearTimeout(t);
  }, [autoDismissMs]);

  const color = useMemo(() => STAMP_COLORS[hashSlug(townSlug) % STAMP_COLORS.length]!, [townSlug]);

  if (!visible) return null;

  const label = townName.toUpperCase();
  const date = new Date().toISOString().slice(0, 10).split("-").reverse().join("·");

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto fixed right-4 z-50 flex items-center gap-3 nb-card-dark px-3 py-2 animate-passport-stamp-in"
      style={{ bottom: TOAST_BOTTOM_PX }}
    >
      <div className="relative h-14 w-14 shrink-0">
        <svg viewBox="-50 -50 100 100" className="h-full w-full animate-passport-stamp-thud" style={{ color }}>
          <g transform="rotate(-6)">
            <circle cx="0" cy="0" r="42" fill="none" stroke={color} strokeWidth="3" opacity="0.85"/>
            <circle cx="0" cy="0" r="37" fill="none" stroke={color} strokeWidth="1" opacity="0.6"/>
            <text
              x="0" y="-8"
              textAnchor="middle"
              fontSize={label.length > 8 ? 8 : 10}
              fontWeight="bold"
              fill={color}
              fontFamily="'Courier New', Menlo, monospace"
              letterSpacing="1"
            >{label.slice(0, 10)}</text>
            <text x="0" y="8" textAnchor="middle" fontSize="12" fill={color}>◆</text>
            <text
              x="0" y="22"
              textAnchor="middle"
              fontSize="6"
              fill={color}
              fontFamily="'Courier New', Menlo, monospace"
              letterSpacing="1"
            >{date}</text>
          </g>
        </svg>
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="text-[10px] font-bold uppercase tracking-widest text-paper/60">
          Stamped
        </div>
        <div className="text-sm font-bold text-paper truncate max-w-[180px]">
          {townName}
        </div>
        <a
          href="/api/passport/pdf"
          className="mt-1 text-[10px] font-bold uppercase tracking-widest text-paper underline decoration-paper/40 underline-offset-2 hover:decoration-paper"
          download
        >
          Download passport →
        </a>
      </div>
      <button
        type="button"
        onClick={() => setVisible(false)}
        aria-label="Dismiss"
        className="ml-1 self-start text-paper/50 hover:text-paper text-xs"
      >
        ✕
      </button>
      <style>{`
        @keyframes passport-stamp-in {
          0%   { opacity: 0; transform: translateY(20px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes passport-stamp-thud {
          0%   { transform: scale(2) rotate(-25deg); opacity: 0; }
          40%  { transform: scale(0.9) rotate(-4deg); opacity: 1; }
          60%  { transform: scale(1.05) rotate(-6deg); }
          100% { transform: scale(1) rotate(-6deg); }
        }
        .animate-passport-stamp-in { animation: passport-stamp-in 260ms ease-out; }
        .animate-passport-stamp-thud { animation: passport-stamp-thud 500ms cubic-bezier(0.2, 1.4, 0.4, 1); transform-origin: center; }
      `}</style>
    </div>
  );
}
