// Per-scene attachment for group chat. The interior scene calls
// `mountGroupChatForScene` once on entry; teardown is wired internally
// via `k.onSceneLeave` so callers don't have to thread anything.
//
// Responsibilities:
//   1. Register the [G] keystroke that toggles the overlay.
//   2. Publish "the player is standing in a group-chat-enabled house"
//      to the store so the floating prompt can render.
//   3. Auto-close the overlay on scene leave so walking out of the
//      house ends the group chat exactly like the user expected.

import type { KAPLAYCtx } from "kaplay";

import {
  getRemotePlayersForScene,
  onRemotesChange,
} from "@/game/realtime";

import { closeRoom, openRoom } from "./channel";
import { groupChatStore } from "./store";

export interface MountGroupChatInput {
  k: KAPLAYCtx;
  /** Town slug — the URL segment, e.g. "harshith". */
  slug: string;
  /** PlotBuilding.id, e.g. "home". */
  buildingId: string;
  /** Short label shown in the overlay header — building.label or id. */
  buildingLabel: string;
  /** Per-building opt-in flag. False → mount is a no-op so callers
   *  don't have to thread the gate. */
  enabled: boolean;
  /** Scene id used by the realtime roster (e.g. `interior:home`).
   *  We watch this scene's remote-player count to gate the `[G]`
   *  prompt — group chat only surfaces when at least one OTHER
   *  player is in the same house. */
  sceneId: string;
}

export function mountGroupChatForScene(input: MountGroupChatInput): void {
  if (!input.enabled) {
    // This building didn't opt in — no key binding, no sub. We still
    // return so the call site stays unconditional.
    return;
  }

  const { k, slug, buildingId, buildingLabel, sceneId } = input;

  // Publish "we're standing in a group-chat-enabled house" so the
  // floating [G] prompt can render. Cleared on scene leave below.
  groupChatStore.setCurrentHouse({
    slug,
    buildingId,
    buildingLabel,
    // channelId + ownerParticipantKey are server-derived; we don't
    // need them for the prompt (only for the live room), so leave
    // them empty here. openRoom fills them in when the user presses G.
    channelId: "",
    ownerParticipantKey: "",
  });

  // Population watch: count other humans in this scene and republish
  // into the store so the prompt + G handler can gate on it. Fire
  // once now and again on every roster change.
  const updatePopulation = () => {
    groupChatStore.setOthersHere(getRemotePlayersForScene(sceneId).length);
  };
  updatePopulation();
  const detachRoster = onRemotesChange(updatePopulation);

  // [G] toggles the overlay. Open kicks off room subscription +
  // backfill; close tears it down. A solo player can open the room
  // too — group chat doubles as the in-building "broadcast to NPCs"
  // surface, and the activity feed surfaces the start so other
  // players know to wander in.
  k.onKeyPress("g", () => {
    const cur = groupChatStore.getState();
    if (cur.open) {
      void closeRoom();
      return;
    }
    void openRoom({ slug, buildingId, buildingLabel });
  });

  // Auto-close on scene leave. The overlay should not survive the
  // walk back to the overworld. closeRoom + setCurrentHouse are both
  // idempotent so double-firing (e.g. if the caller adds its own
  // teardown later) is safe.
  k.onSceneLeave(() => {
    void closeRoom();
    groupChatStore.setCurrentHouse(null);
    detachRoster();
  });
}
