// Isolated store for the group-chat overlay state. Kept out of the
// global `ui/store.ts` on purpose — deleting this feature should not
// require editing the central store. Same pub/sub shape so React's
// useSyncExternalStore can drive it identically.
//
// One overlay at a time — the player is only ever in one house.

import type { GroupMessageRow } from "../types";
import { TYPING_TTL_MS } from "../types";

export type GroupChatRoom = {
  slug: string;
  buildingId: string;
  buildingLabel: string;
  channelId: string;
};

export type TypingEntry = {
  authorKey: string;
  authorName: string;
  isNpc: boolean;
  /** performance.now() when this entry should be considered stale. */
  expiresAt: number;
};

export type GroupChatState = {
  /** Whether the overlay panel is rendered. Subscribed status is
   *  separate — we only hold a Centrifugo sub while `open` is true. */
  open: boolean;
  /** Current room the overlay is bound to. Set on open, cleared on close. */
  room: GroupChatRoom | null;
  /** The house the player is currently standing in, if it opted in.
   *  Drives the floating [G] prompt visibility. Set by the interior
   *  scene on enter, cleared on leave — independent of `open` so the
   *  prompt shows even before the user presses G. */
  currentHouse: GroupChatRoom | null;
  messages: GroupMessageRow[];
  /** Keyed by authorKey so a re-publish from the same author refreshes
   *  the expiry instead of stacking entries. */
  typing: Map<string, TypingEntry>;
  /** Lifecycle status — drives "Connecting…" / "Disconnected" copy. */
  status: "idle" | "loading" | "ready" | "error";
  /** Empty string when status === "error" but no human-friendly message. */
  errorMessage: string;
};

let state: GroupChatState = {
  open: false,
  room: null,
  currentHouse: null,
  messages: [],
  typing: new Map(),
  status: "idle",
  errorMessage: "",
};

const listeners = new Set<() => void>();
const openListeners = new Set<(open: boolean) => void>();

function emit() {
  for (const l of listeners) l();
}

function emitOpen() {
  for (const l of openListeners) l(state.open);
}

function set(next: Partial<GroupChatState>) {
  const wasOpen = state.open;
  state = { ...state, ...next };
  emit();
  if (state.open !== wasOpen) emitOpen();
}

export const groupChatStore = {
  getState(): GroupChatState {
    return state;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  openRoom(room: GroupChatRoom) {
    set({
      open: true,
      room,
      messages: [],
      typing: new Map(),
      status: "loading",
      errorMessage: "",
    });
  },
  setReady(messages: GroupMessageRow[]) {
    set({ messages, status: "ready", errorMessage: "" });
  },
  setError(msg: string) {
    set({ status: "error", errorMessage: msg });
  },
  appendMessage(m: GroupMessageRow) {
    // Dedupe by id — server-side persist publishes the same row the
    // client just POSTed, and the history endpoint may overlap with
    // an in-flight publish.
    if (state.messages.some((x) => x.id === m.id)) return;
    set({ messages: [...state.messages, m] });
  },
  setTyping(entry: Omit<TypingEntry, "expiresAt">) {
    const next = new Map(state.typing);
    next.set(entry.authorKey, {
      ...entry,
      expiresAt: performance.now() + TYPING_TTL_MS,
    });
    set({ typing: next });
  },
  /** Drop typing entries whose `expiresAt` has passed. Called from a
   *  cheap interval the surface owns. */
  pruneTyping() {
    const now = performance.now();
    let changed = false;
    const next = new Map(state.typing);
    for (const [k, v] of next) {
      if (v.expiresAt <= now) {
        next.delete(k);
        changed = true;
      }
    }
    if (changed) set({ typing: next });
  },
  /** Drop a specific typing entry — used when their message lands so
   *  the indicator clears immediately, not after a 3.5s decay. */
  clearTyping(authorKey: string) {
    if (!state.typing.has(authorKey)) return;
    const next = new Map(state.typing);
    next.delete(authorKey);
    set({ typing: next });
  },
  closeRoom() {
    if (!state.open && state.room === null) return;
    set({
      open: false,
      room: null,
      messages: [],
      typing: new Map(),
      status: "idle",
      errorMessage: "",
    });
  },
  setCurrentHouse(house: GroupChatRoom | null) {
    if (state.currentHouse === house) return;
    set({ currentHouse: house });
  },
};

// Public, side-effect-free predicate exported through the feature
// barrel. Interior scene calls this to gate NPC interactables — when
// the overlay is open, SPACE on an NPC is suppressed.
export function isGroupChatOverlayOpen(): boolean {
  return state.open;
}

/** Subscribe to overlay open/close changes. Kaplay code uses this to
 *  flip its NPC-gate predicate without importing the React state shape. */
export function subscribeGroupChatOpen(
  fn: (open: boolean) => void,
): () => void {
  openListeners.add(fn);
  return () => {
    openListeners.delete(fn);
  };
}
