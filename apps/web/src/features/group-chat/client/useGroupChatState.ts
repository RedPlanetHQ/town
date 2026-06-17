"use client";

// React bridge — same pattern as ui/useUiStore.ts but for the isolated
// group-chat store. Components subscribe through this hook to stay
// decoupled from the store internals.

import { useSyncExternalStore } from "react";

import { groupChatStore } from "./store";

export function useGroupChatState() {
  return useSyncExternalStore(
    groupChatStore.subscribe,
    groupChatStore.getState,
    groupChatStore.getState,
  );
}
