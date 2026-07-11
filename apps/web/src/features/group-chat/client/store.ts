// Isolated store for the group-chat overlay state. Kept out of the
// global `ui/store.ts` on purpose — deleting this feature should not
// require editing the central store. Same pub/sub shape so React's
// useSyncExternalStore can drive it identically.
//
// One overlay at a time — the player is only ever in one house.
//
// Topics live alongside a synthetic "#general" thread represented by
// activeTopicId=null. Messages, typing pulses, and unread counts are
// all bucketed by topicKey so switching threads is a pure store swap
// without another network round-trip.

import type { GroupMessageRow, GroupTopicRow } from "../types";
import { TYPING_TTL_MS } from "../types";

/** Key used in the per-topic maps — "general" for the null bucket
 *  so we can drop it in as a Map key without allowing arbitrary
 *  collisions with cuid topic ids. */
export const GENERAL_KEY = "general";

export type TopicKey = string;

export function topicKeyOf(topicId: string | null): TopicKey {
  return topicId ?? GENERAL_KEY;
}

export type GroupChatRoom = {
  slug: string;
  buildingId: string;
  buildingLabel: string;
  channelId: string;
  /** participantKey for the town owner — used by the surface to render
   *  "(owner)" next to the resident's name. Empty when the room is
   *  in its tentative pre-history state. */
  ownerParticipantKey: string;
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
  /** How many OTHER human players are in the same interior scene
   *  right now. Updated live by the attach module via the realtime
   *  roster. Surfaced in the floating `[G]` prompt as a "· N here"
   *  hint — no longer gates the affordance itself (solo players can
   *  open the room too; the activity feed surfaces the start). */
  othersHere: number;
  /** Active (unexpired) user-created topics on this room channel,
   *  newest first. #general is implicit — it doesn't live here. */
  topics: GroupTopicRow[];
  /** Which topic the composer is pointed at. null = #general. */
  activeTopicId: string | null;
  /** topicKey → messages. Keyed with GENERAL_KEY for #general and
   *  topic.id otherwise so a single dispatch table covers both. */
  messagesByTopic: Map<TopicKey, GroupMessageRow[]>;
  /** Per-topic typing map. Same shape as before but scoped so a
   *  typer in #general doesn't leak into a topic view. */
  typingByTopic: Map<TopicKey, Map<string, TypingEntry>>;
  /** Unread counts for non-active topics. Cleared on switch. */
  unreadByTopic: Map<TopicKey, number>;
  /** Lifecycle status — drives "Connecting…" / "Disconnected" copy. */
  status: "idle" | "loading" | "ready" | "error";
  /** Empty string when status === "error" but no human-friendly message. */
  errorMessage: string;
};

function emptyState(): GroupChatState {
  return {
    open: false,
    room: null,
    currentHouse: null,
    othersHere: 0,
    topics: [],
    activeTopicId: null,
    messagesByTopic: new Map(),
    typingByTopic: new Map(),
    unreadByTopic: new Map(),
    status: "idle",
    errorMessage: "",
  };
}

let state: GroupChatState = emptyState();

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
      topics: [],
      activeTopicId: null,
      messagesByTopic: new Map(),
      typingByTopic: new Map(),
      unreadByTopic: new Map(),
      status: "loading",
      errorMessage: "",
    });
  },
  setReady(messages: GroupMessageRow[], topics: GroupTopicRow[]) {
    set({
      messagesByTopic: bucketMessages(messages),
      topics,
      status: "ready",
      errorMessage: "",
    });
  },
  setError(msg: string) {
    set({ status: "error", errorMessage: msg });
  },
  appendMessage(m: GroupMessageRow) {
    const key = topicKeyOf(m.topicId);
    const existing = state.messagesByTopic.get(key) ?? [];
    // Dedupe by id — server-side persist publishes the same row the
    // client just POSTed, and the history endpoint may overlap with
    // an in-flight publish.
    if (existing.some((x) => x.id === m.id)) return;
    const next = new Map(state.messagesByTopic);
    next.set(key, [...existing, m]);
    // Bump unread for non-active topics only.
    let unread = state.unreadByTopic;
    if (state.activeTopicId !== m.topicId) {
      unread = new Map(unread);
      unread.set(key, (unread.get(key) ?? 0) + 1);
    }
    set({ messagesByTopic: next, unreadByTopic: unread });
  },
  addTopic(topic: GroupTopicRow) {
    // Dedupe — the topic-created wire lands even for the creator.
    if (state.topics.some((t) => t.id === topic.id)) return;
    set({ topics: [topic, ...state.topics] });
  },
  removeTopic(topicId: string) {
    if (!state.topics.some((t) => t.id === topicId)) return;
    const topics = state.topics.filter((t) => t.id !== topicId);
    // If the deleted topic was the active one, fall back to #general so
    // the composer stays live for everyone with the panel open.
    const activeTopicId =
      state.activeTopicId === topicId ? null : state.activeTopicId;
    set({ topics, activeTopicId });
  },
  /** Force a re-render so per-topic "Xm left" / "expired" labels
   *  refresh without waiting on a store mutation. Sidebar owns a 30s
   *  tick that fires this. */
  refreshTopicClocks() {
    // No content change — just bump listeners so time-derived labels
    // (expired, "42m left") re-compute against the current clock.
    set({});
  },
  switchTopic(topicId: string | null) {
    if (state.activeTopicId === topicId) return;
    // Clear unread for the topic we're switching INTO.
    const key = topicKeyOf(topicId);
    const unread = new Map(state.unreadByTopic);
    if (unread.has(key)) unread.delete(key);
    set({ activeTopicId: topicId, unreadByTopic: unread });
  },
  setTyping(
    entry: Omit<TypingEntry, "expiresAt"> & { topicId: string | null },
  ) {
    const key = topicKeyOf(entry.topicId);
    const topicMap = new Map(state.typingByTopic.get(key) ?? []);
    topicMap.set(entry.authorKey, {
      authorKey: entry.authorKey,
      authorName: entry.authorName,
      isNpc: entry.isNpc,
      expiresAt: performance.now() + TYPING_TTL_MS,
    });
    const next = new Map(state.typingByTopic);
    next.set(key, topicMap);
    set({ typingByTopic: next });
  },
  /** Drop typing entries whose `expiresAt` has passed. Called from a
   *  cheap interval the surface owns. */
  pruneTyping() {
    const now = performance.now();
    let anyChanged = false;
    const next = new Map(state.typingByTopic);
    for (const [key, m] of next) {
      let changed = false;
      const inner = new Map(m);
      for (const [k, v] of inner) {
        if (v.expiresAt <= now) {
          inner.delete(k);
          changed = true;
        }
      }
      if (changed) {
        next.set(key, inner);
        anyChanged = true;
      }
    }
    if (anyChanged) set({ typingByTopic: next });
  },
  /** Drop a specific typing entry — used when their message lands so
   *  the indicator clears immediately, not after a 3.5s decay. */
  clearTyping(topicId: string | null, authorKey: string) {
    const key = topicKeyOf(topicId);
    const inner = state.typingByTopic.get(key);
    if (!inner || !inner.has(authorKey)) return;
    const next = new Map(state.typingByTopic);
    const clone = new Map(inner);
    clone.delete(authorKey);
    next.set(key, clone);
    set({ typingByTopic: next });
  },
  closeRoom() {
    if (!state.open && state.room === null) return;
    // Preserve `currentHouse` + `othersHere` — those are scene state
    // owned by attach.ts (set on interior enter, cleared on scene
    // leave). If we nuked them here the floating "[G] Group chat"
    // prompt would vanish after the player closes the panel, even
    // though they're still standing in the same room. Only the
    // panel-specific state (open, room, topics, messages, typing,
    // unread, status) resets.
    const preserved = {
      currentHouse: state.currentHouse,
      othersHere: state.othersHere,
    };
    set({ ...emptyState(), ...preserved });
  },
  setCurrentHouse(house: GroupChatRoom | null) {
    if (state.currentHouse === house) return;
    // Clearing currentHouse → also reset othersHere so we don't carry
    // a stale population count from a previous house into a future
    // visit. Setting a fresh house leaves the count for attach.ts to
    // re-publish once it has the live roster.
    set({ currentHouse: house, othersHere: house === null ? 0 : state.othersHere });
  },
  setOthersHere(n: number) {
    if (state.othersHere === n) return;
    set({ othersHere: n });
  },
};

function bucketMessages(
  messages: GroupMessageRow[],
): Map<TopicKey, GroupMessageRow[]> {
  const out = new Map<TopicKey, GroupMessageRow[]>();
  for (const m of messages) {
    const key = topicKeyOf(m.topicId);
    const list = out.get(key) ?? [];
    list.push(m);
    out.set(key, list);
  }
  return out;
}

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

/** Selector: messages for the currently active topic. Empty array
 *  when the store is not ready or the bucket has no messages yet. */
export function selectActiveMessages(
  s: GroupChatState = state,
): GroupMessageRow[] {
  return s.messagesByTopic.get(topicKeyOf(s.activeTopicId)) ?? [];
}

/** Selector: typing entries for the currently active topic. */
export function selectActiveTyping(
  s: GroupChatState = state,
): Map<string, TypingEntry> {
  return s.typingByTopic.get(topicKeyOf(s.activeTopicId)) ?? new Map();
}
