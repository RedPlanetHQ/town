"use client";

// "Create another town" modal — CLI instructions in the shared
// `NewTownInstructions` body. Used from the identity dropdown's
// "+ New town" entry and from the dashboard's "+ New town" link.

import { useEffect } from "react";

import { NewTownInstructions } from "./NewTownInstructions";

export function NewTownModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nb-card-dark flex w-full max-w-md flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-3 border-b-2 border-paper/15 pb-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-paper/60">
              New town
            </div>
            <h2 className="mt-1 text-2xl font-black leading-tight text-paper">
              Create another town
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="border-2 border-paper/30 px-2 py-1 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10"
            aria-label="Close new town"
          >
            ESC
          </button>
        </div>
        <p className="text-sm font-bold text-paper/80">
          Towns are created from the CLI so you can keep authoring next
          to your editor.
        </p>
        <NewTownInstructions variant="modal" />
      </div>
    </div>
  );
}
