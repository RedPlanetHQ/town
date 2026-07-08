// Canvas focus policy — one place to return keyboard focus to the game.
//
// kaplay's keydown listener is attached to the canvas element, not the
// document, so any HUD button / popover item that keeps DOM focus after
// a click stops arrow keys from reaching the world. Instead of blurring
// each button manually, TownGame installs a single global click listener
// (see useCanvasFocusPolicy) that returns focus to the canvas after any
// click that landed on a non-text element and didn't open a modal.

/** Locate and focus the kaplay canvas. Safe to call before mount — a
 *  no-op if the canvas isn't in the DOM yet. */
export function focusGameCanvas(): void {
  const canvas =
    document.querySelector<HTMLCanvasElement>("[data-town-canvas]");
  canvas?.focus?.();
}

/** Elements that legitimately keep focus after a click. Text inputs,
 *  textareas, and any contenteditable node need it for typing; select
 *  keeps focus for keyboard navigation of its options. */
function isTextInputLike(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    // Buttons rendered as <input type="button"> should NOT keep focus.
    return type !== "button" && type !== "submit" && type !== "reset";
  }
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/** Options for the click-based auto-return listener. */
export interface CanvasFocusPolicyOpts {
  /** Called each frame the check runs — return true to skip (e.g. any
   *  modal open). When true, the modal's own focus policy takes over
   *  and we don't touch anything. */
  shouldSkip: () => boolean;
}

/** Install the global click listener. Returns an unbind. The listener
 *  runs on next animation frame after every click so React has time to
 *  render whatever modal / popover the click opened; then, if focus
 *  landed on a non-text element and no modal claims the world, it
 *  hands focus back to the game canvas. */
export function installCanvasFocusPolicy(
  opts: CanvasFocusPolicyOpts,
): () => void {
  function onClick() {
    requestAnimationFrame(() => {
      if (opts.shouldSkip()) return;
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return;
      // Skip: text inputs, textareas, contenteditable — the user is
      // typing there and expects focus to stay.
      if (isTextInputLike(active)) return;
      // Opt-out escape hatch: any subtree marked data-keep-focus="true"
      // holds its own focus (custom widgets, embeds).
      if (active.closest("[data-keep-focus='true']")) return;
      // Everything else — HUD buttons, popover items, links — hands
      // focus back to the game. Real modals are already filtered out
      // by shouldSkip (which reads ui.isPaused).
      active.blur?.();
      focusGameCanvas();
    });
  }
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
