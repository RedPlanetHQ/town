"use client";

import type { PromptState } from "./store";

// Floating "[KEY] <action>" prompt anchored to the bottom-center of the
// viewport while the player is adjacent to an interactable. Callers
// pass `prompt.key` when the key is something other than SPACE (e.g.
// "E" for building-entry).
export function InteractionPrompt({ prompt }: { prompt: NonNullable<PromptState> }) {
  return (
    <div className="nb-card-dark flex items-center gap-2 px-3 py-1.5">
      <kbd className="inline-flex h-5 items-center border-2 border-paper/30 bg-paper px-1.5 text-xs font-bold uppercase tracking-wider text-ink">
        {prompt.key ?? "SPACE"}
      </kbd>
      <span className="text-xs font-bold uppercase tracking-wider text-paper">
        {prompt.label}
      </span>
    </div>
  );
}
