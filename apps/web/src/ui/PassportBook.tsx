"use client";

// Paginated passport book — one spread at a time with prev / next
// controls. Server pre-renders each spread's SVG (so this stays a
// leaf client component with no data-fetching); we just toggle which
// one is visible.

import { useState } from "react";

export function PassportBook({
  spreads,
  stampCount,
}: {
  spreads: string[];         // one SVG string per spread
  stampCount: number;
}) {
  const [idx, setIdx] = useState(0);
  const total = spreads.length;
  const canPrev = idx > 0;
  const canNext = idx < total - 1;

  return (
    <div className="flex flex-col gap-3">
      <div
        className="overflow-hidden border-2 border-paper/15"
        // Trusted SVG from server-side data — see esc() in
        // lib/passport/render.ts. Never returns unescaped input.
        dangerouslySetInnerHTML={{ __html: spreads[idx] ?? "" }}
      />

      <div className="flex items-center justify-between gap-3 text-[10px] font-mono uppercase tracking-widest text-paper/50">
        <button
          type="button"
          onClick={() => canPrev && setIdx((i) => i - 1)}
          disabled={!canPrev}
          className="border-2 border-paper/30 px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10 disabled:opacity-30"
        >
          ← Prev
        </button>
        <span>
          Page {idx + 1} of {total} · {stampCount} stamp{stampCount === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={() => canNext && setIdx((i) => i + 1)}
          disabled={!canNext}
          className="border-2 border-paper/30 px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10 disabled:opacity-30"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
