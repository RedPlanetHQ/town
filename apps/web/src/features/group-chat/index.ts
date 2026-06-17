// Public exports — the only thing outside the folder is allowed to import
// from here. Keep this surface small: scene-attach, the React overlays,
// and the open-state predicate.
//
// Feature gating is purely per-building (PlotBuilding.groupChatEnabled).
// Houses that opt in get the [G] prompt + room; everything else stays
// silent. No global env switch — the source of truth is one place, the
// plot.

export { mountGroupChatForScene } from "./client/attach";
export { GroupChatSurface } from "./ui/GroupChatSurface";
export { GroupChatPrompt } from "./ui/GroupChatPrompt";
export {
  isGroupChatOverlayOpen,
  subscribeGroupChatOpen,
} from "./client/store";
