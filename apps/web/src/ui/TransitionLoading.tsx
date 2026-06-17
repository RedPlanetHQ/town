"use client";

// Mid-game scene-transition loader. The first-mount load is owned by
// <BootScreen> (controlled by local React state in TownGame); this
// covers every transition AFTER that — most visibly the
// interior → overworld walk-back, which currently shows a blank green
// canvas while the new scene fetches its plot + sprites and re-draws.
//
// Mounts whenever `worldReady` is false but the boot screen has
// already dismissed itself. Sits over the canvas as a centered card
// so the player doesn't think the game has hung.

export function TransitionLoading() {
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-ink-shadow/40">
      <div
        className="flex items-center gap-3 rounded-md border-2 border-ink bg-paper px-5 py-3 shadow-[6px_6px_0_0_#1a1d22]"
        role="status"
        aria-live="polite"
      >
        <span className="text-[12px] font-bold uppercase tracking-wider text-ink">
          Loading
        </span>
      </div>
    </div>
  );
}
