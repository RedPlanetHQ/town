"use client";

import { useEffect, useState } from "react";

// Fullscreen CORE OS-style boot screen + plot-loading hold. Pixel-font
// title, "booting…" subtitle, progress bar sweeping to 100% over ~1.4s,
// then "loading town…" if the kaplay scene hasn't told us
// (`worldReady`) that the plot is drawn yet. Single overlay covers the
// whole startup so there's no flash between the boot bar and an
// in-canvas loading state.

export function BootScreen({
  ready,
  onDone,
}: {
  /** Flips true once the kaplay scene has fetched the plot + drawn
   *  it. BootScreen holds on screen until BOTH the sweep finishes
   *  AND this is true. */
  ready: boolean;
  onDone: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const [swept, setSwept] = useState(false);

  // Sweep animation runs once on mount.
  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const start = performance.now();
    const DURATION = 1400;

    const tick = (now: number) => {
      if (cancelled) return;
      const pct = Math.min(100, ((now - start) / DURATION) * 100);
      setProgress(pct);
      if (pct < 100) {
        raf = requestAnimationFrame(tick);
      } else {
        setSwept(true);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  // Dismiss once the sweep AND ready signal have both landed. Tiny
  // breath at 100% before fading out so the user sees the bar
  // complete instead of snapping away mid-animation.
  useEffect(() => {
    if (!swept || !ready) return;
    const t = window.setTimeout(onDone, 220);
    return () => window.clearTimeout(t);
  }, [swept, ready, onDone]);

  // Subtitle shifts from booting → loading once the boot bar finishes
  // but the world isn't drawn yet.
  const subtitle = swept && !ready ? "loading town…" : "booting…";

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#1a1a1a] font-mono text-[#e8e4d8]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/town_logo_light.svg"
        alt="town"
        className="mb-3 h-24 w-24"
        draggable={false}
      />
      <div
        className="mb-6 text-[20px] font-semibold tracking-tight text-[#e8e4d8]"
        style={{ fontFamily: "var(--font-press-start-2p)" }}
      >
        town
      </div>
      <div className="mb-8 text-[12px] opacity-70">{subtitle}</div>
      <div className="h-3 w-[280px] border border-white/40 bg-black/40">
        <div
          className="h-full bg-[#0381e9] transition-[width] duration-100"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
