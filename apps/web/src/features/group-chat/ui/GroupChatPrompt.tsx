"use client";

// Floating "[G] Group chat" hint. Visible when:
//   • the player is inside a house that opted into group chat
//     (currentHouse !== null in the store, set by the interior scene), and
//   • the overlay itself isn't open (the panel speaks for it then).
//
// Self-contained — reads the store directly so the layout call site
// stays a single <GroupChatPrompt /> with no props plumbing.

import { useGroupChatState } from "../client/useGroupChatState";

export function GroupChatPrompt() {
  const state = useGroupChatState();
  if (!state.currentHouse) return null;
  if (state.open) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-md border-2 border-ink bg-paper px-3 py-1.5 shadow-[4px_4px_0_0_#1a1d22]">
      <span className="border-2 border-ink bg-ink px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-paper">
        G
      </span>
      <span className="text-[12px] font-bold leading-none text-ink">
        Group chat · {state.currentHouse.buildingLabel}
        <span className="ml-1 opacity-60">
          · {state.othersHere + 1} here
        </span>
      </span>
    </div>
  );
}
