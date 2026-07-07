"use client";

import { useEffect, useRef } from "react";

import { ui } from "./store";

// Auto-opens on every page load into a town (replaces the previous
// welcome dialogue) and is reachable any time via the "Instructions"
// pill in the bottom-left toolbar. Two stacked blocks: the owner's
// town description on top, a fixed "how to play" cheatsheet below.
//
// Layout notes:
//  • Two visual columns for controls — real keys (kbd chips) on the
//    left, non-key actions ("walk into door", "aura bar") as small
//    icon+label rows on the right. Keeps the kbd chips uniformly
//    sized instead of stretching them to fit multi-word labels.
//  • Close (×) icon in the header, matches the game's ESC-driven
//    dismiss model without a chunky text button competing with the
//    town title.
//  • Primary CTA spans full width for a clear "get me in" target.

export function TownInstructionsModal({
  townName,
  townDescription,
}: {
  townName: string;
  townDescription: string | null;
}) {
  const exploreRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    exploreRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        ui.closeInstructions();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const description =
    (townDescription && townDescription.trim()) ||
    "The owner hasn't written a description yet — wander around and see what you find.";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) ui.closeInstructions();
      }}
    >
      <div
        className="nb-card-dark flex w-full max-w-md flex-col gap-6 p-7"
        style={{ borderColor: "rgba(246, 243, 234, 0.12)" }}
      >
        <Header townName={townName} />

        <p className="whitespace-pre-line text-sm leading-relaxed text-paper/75">
          {description}
        </p>

        <Controls />

        <button
          ref={exploreRef}
          type="button"
          onClick={() => ui.closeInstructions()}
          className="mt-1 w-full border-2 border-paper/25 bg-paper/10 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-paper transition-colors focus:outline-none focus:ring-2 focus:ring-primary hover:border-primary hover:bg-primary/15 hover:text-primary"
        >
          Explore town →
        </button>
      </div>
    </div>
  );
}

function Header({ townName }: { townName: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-paper/50">
          You&apos;re in
        </div>
        <h2 className="mt-1.5 truncate text-2xl font-bold uppercase tracking-wider text-paper">
          {townName}
        </h2>
      </div>
      <button
        type="button"
        onClick={() => ui.closeInstructions()}
        className="flex-none text-paper/40 transition-colors hover:text-paper"
        aria-label="Close instructions"
        title="Close (ESC)"
      >
        <svg width={20} height={20} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M6 6l12 12M6 18L18 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="square"
          />
        </svg>
      </button>
    </div>
  );
}

function Controls() {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-paper/50">
        How to play
      </div>
      <ul className="flex flex-col gap-2.5">
        <KeyRow keys={["↑", "↓", "←", "→"]}>Walk around the town</KeyRow>
        <KeyRow keys={["SPACE"]}>Talk to a nearby NPC or neighbour</KeyRow>
        <KeyRow keys={["ESC"]}>Close a dialogue or modal</KeyRow>
        <IconRow icon={<DoorIcon />}>Walk into a door to enter a building</IconRow>
        <IconRow icon={<SparkIcon />}>
          Aura is the town&apos;s energy — chat and NPCs draw from it
        </IconRow>
      </ul>
    </div>
  );
}

function KeyRow({
  keys,
  children,
}: {
  keys: string[];
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex flex-none items-center gap-1">
        {keys.map((k) => (
          <kbd
            key={k}
            className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-sm border border-paper/25 bg-paper/[0.06] px-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-paper shadow-[0_1px_0_0_rgba(0,0,0,0.4)]"
          >
            {k}
          </kbd>
        ))}
      </span>
      <span className="flex-1 text-xs font-medium text-paper/80">{children}</span>
    </li>
  );
}

function IconRow({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3">
      <span
        aria-hidden
        className="flex h-6 w-6 flex-none items-center justify-center rounded-sm border border-paper/20 bg-paper/[0.04] text-paper/70"
      >
        {icon}
      </span>
      <span className="flex-1 text-xs font-medium text-paper/80">{children}</span>
    </li>
  );
}

function DoorIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 3h12v18H6zM10 12h.01"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
      />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" />
    </svg>
  );
}
