// OS-level Notification API integration for new DMs.
//
// Sits alongside the in-page WebAudio ding from sound.ts. The ding handles
// the case where the tab is focused; this module handles the case where
// the user is in a different tab, a different app, or has the window
// minimized — same surface WhatsApp Web / Slack use for "you got a
// message" banners.
//
// Permission request rules:
//   • Browsers reject `Notification.requestPermission()` without a user
//     gesture. We can't call it on game boot. Instead we arm a one-shot
//     listener for the first `keydown` / `pointerdown` and request then.
//   • Once the user answers, we cache the decision and stop arming.
//   • If they deny, we never re-ask (re-asking annoys users; they can
//     re-enable from the browser site-settings UI).
//
// Click-to-open:
//   • Clicking a notification focuses the window and opens the DM with
//     the sender. We route through the ui store so it works the same
//     way as clicking a pending pill in the canvas.

import { ui } from "../ui/store";

const LOG = "[notify]";

type NotifyPayload = {
  fromKey: string;
  fromName: string;
  preview: string;
  townSlug: string;
};

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.Notification !== "undefined"
  );
}

let armed = false;
let asked = false;

// Arm a one-shot permission request on the first real user gesture.
// Idempotent — startRealtime can call it on every boot.
export function armNotifications(): void {
  if (!isSupported()) return;
  if (armed) return;
  // Already decided in a previous session — nothing to do.
  if (Notification.permission !== "default") {
    asked = true;
    return;
  }
  armed = true;

  const trigger = () => {
    if (asked) return;
    asked = true;
    window.removeEventListener("keydown", trigger);
    window.removeEventListener("pointerdown", trigger);
    try {
      void Notification.requestPermission().then((perm) => {
        console.log(`${LOG} permission=${perm}`);
      });
    } catch (e) {
      console.warn(`${LOG} requestPermission threw`, e);
    }
  };
  // `once: true` would handle the cleanup but using two listeners
  // means whichever fires first cancels the other.
  window.addEventListener("keydown", trigger);
  window.addEventListener("pointerdown", trigger);
}

// Render an OS notification for an incoming DM. No-op when:
//   • the browser doesn't support it
//   • the user hasn't granted permission
//   • the tab is visible AND the DM panel for this sender is already open
//     (we'd be double-notifying — the user is literally reading it).
export function showMessageNotification(p: NotifyPayload): void {
  if (!isSupported()) return;
  if (Notification.permission !== "granted") return;

  const tabVisible =
    typeof document !== "undefined" && document.visibilityState === "visible";
  const openDm = ui.getState().dm;
  const alreadyReading =
    tabVisible &&
    openDm !== null &&
    openDm.otherKey === p.fromKey &&
    openDm.townSlug === p.townSlug;
  if (alreadyReading) return;

  try {
    const n = new Notification(p.fromName, {
      body: p.preview,
      // Tag dedupes notifications per-sender so a rapid burst collapses
      // into a single banner instead of stacking N copies. The banner
      // updates silently — our in-page WebAudio ding still fires on
      // every message, so the user gets one ping per message but only
      // one persistent banner per sender.
      tag: `dm:${p.townSlug}:${p.fromKey}`,
      icon: "/favicon.ico",
    });
    n.onclick = () => {
      try {
        window.focus();
        ui.openDm({
          townSlug: p.townSlug,
          otherKey: p.fromKey,
          otherName: p.fromName,
        });
      } finally {
        n.close();
      }
    };
  } catch (e) {
    console.warn(`${LOG} new Notification threw`, e);
  }
}
