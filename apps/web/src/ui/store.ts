// UI store — the bridge between kaplay (which simulates the world) and React
// (which renders all UI surfaces: HUD, SPACE prompt, modals, login form, etc.).
//
// Kaplay scenes call setters (setHud, setPrompt, openPanel) to publish UI
// state. React subscribes with useSyncExternalStore and re-renders. No
// engine cares about the other's internals.
//
// Pause semantics: when any modal is open, the game world should freeze.
// Player movement reads `getState().paused` and skips frames while true.

import type { Session } from "../game/auth";

export type HudKind =
  | { kind: "overworld"; session: Session | null }
  | { kind: "interior"; title: string; accent: string };

export type PromptState = {
  // Shown in the floating bottom-center prompt. Null = no prompt.
  label: string;
  accent: string;
  // Which key the kbd chip renders. Defaults to "SPACE" for the talk /
  // interact prompts. Building-entry prompts pass `"E"` so the same
  // component reads as "E to enter" without a second visual style.
  key?: string;
} | null;

export type PanelAction = {
  label: string;
  onPress: () => void;
};

export type PanelState = {
  title: string;
  lines: string[];
  accent: string;
  action?: PanelAction;
  // Used to identify which interactable is open so an action can re-resolve
  // and re-publish the panel (e.g. profile flips guest→signed in).
  key: string;
} | null;

// Memory explorer overlay (LIBRARY → table interaction). Null = closed.
export type ExplorerState = { open: true } | null;

// Invite modal — URL + share code. Opened from the identity card
// dropdown's "Invite" action.
export type InviteState = { open: true } | null;

// Share-image modal — screenshot preview + download / Twitter / WhatsApp
// share buttons. Opened from the identity card dropdown's "Share" action.
export type ShareImageState = { open: true } | null;

// Instructions modal — town description + how-to-play cheatsheet.
// Auto-opens on every page load into a town (replaces the old auto-fire
// welcome dialogue) and is also reachable any time from the "Instructions"
// pill in the bottom-left toolbar.
export type InstructionsState = { open: true } | null;

// Cmd+K command palette — searchable teleport list of every building on
// the active plot. Opened by Cmd/Ctrl+K, closed by ESC or selection.
export type CommandBarState = { open: true } | null;

// Town activity feed — slide-in panel on the right edge of the screen.
// Opened from the top-right FEED button on the overworld HUD. Visitor
// + owner both see the same feed.
export type FeedState = { open: true } | null;

// Closest remote player within talk-distance, set by the scene's
// proximity tick. The InteractionPrompt reads from this to render
// "SPACE to talk to <name>".
export type ProximityState = {
  participantKey: string;
  name: string;
  character: string;
} | null;

// Open DM panel — opened from the proximity prompt (SPACE) or from a
// pending-reply pill. Centrifugo + DB-backed.
export type DmState = {
  townSlug: string;
  otherKey: string;
  otherName: string;
} | null;

// Reusable typewriter dialogue (HOME NPC, future NPCs). Lines render one at
// a time and the action button reveals after the last line finishes.
export type DialogueAction = {
  label: string;
  onPress: () => void;
};

export type DialogueState = {
  // Used to identify the same dialogue across re-renders (avoids restart
  // when the same NPC re-publishes a follow-up).
  key: string;
  speaker: string;            // e.g. "Hudson" or NPC name
  lines: string[];            // each line types out before the next starts
  accent: string;
  action?: DialogueAction;    // primary action revealed at the end
  // Optional secondary action (e.g. "Not now") shown alongside the primary.
  secondary?: DialogueAction;
} | null;

// Streaming NPC chat overlay. By default wired to /api/npc-chat (the
// generic NPC route); the Founder overrides via `chatApi` so its own
// /api/founder-chat handler can ship a different prompt + tools without
// affecting every other NPC's flow. Mode controls whether the LLM is
// briefed as a direct 1:1 with the player, or as a chat the player has
// invited someone into (the invitee is just a label in the system
// prompt today).
export type ChatState = {
  npcId: string;
  speaker: string;
  description: string;
  accent: string;
  mode?: "direct" | "invited";
  invitee?: { name: string };
  /** Override the chat endpoint. Defaults to /api/npc-chat. */
  chatApi?: string;
} | null;

// Pending PlotSuggestion list + the sidebar's open/closed state.
//
// The poller writes `list` + `count` on every probe. The HUD reads `count`
// for the badge. Clicking the badge sets `open=true`, which renders the
// right sidebar with the full list and Apply/Decline buttons per row.
//
// Effect payload is the raw discriminated Effect from decide.ts — we just
// pass it through to the UI rather than re-shaping on the wire.
export type SuggestionPayload =
  | { kind: "add-building"; plotKey: string; reason: string }
  | {
      kind: "update-npc";
      npcId: string;
      fields: Record<string, string>;
      reason: string;
    }
  | {
      kind: "add-npc";
      buildingId: string;
      name: string;
      description: string;
      prompt: string;
      reason: string;
    };

export type SuggestionItem = {
  id: string;
  kind: SuggestionPayload["kind"];
  status: "pending" | "approved" | "declined";
  payload: SuggestionPayload;
  reason: string;
  sourceEventId: string | null;
  createdAt: string;
};

export type SuggestionsState = {
  count: number;
  list: SuggestionItem[];
  // Drawer open/closed state.
  open: boolean;
  // ISO timestamp of the last successful poll.
  fetchedAt: string;
};

type State = {
  hud: HudKind | null;
  prompt: PromptState;
  panel: PanelState;
  explorer: ExplorerState;
  dialogue: DialogueState;
  chat: ChatState;
  invite: InviteState;
  shareImage: ShareImageState;
  instructions: InstructionsState;
  commandBar: CommandBarState;
  feed: FeedState;
  proximity: ProximityState;
  dm: DmState;
  suggestions: SuggestionsState;
  // True once the active scene has fetched the plot + manifest + drawn
  // the world. BootScreen holds itself on screen until this flips so
  // there's a single uninterrupted loading state instead of three.
  worldReady: boolean;
};

let state: State = {
  hud: null,
  prompt: null,
  panel: null,
  explorer: null,
  dialogue: null,
  chat: null,
  invite: null,
  shareImage: null,
  instructions: null,
  commandBar: null,
  feed: null,
  proximity: null,
  dm: null,
  suggestions: {
    count: 0,
    list: [],
    open: false,
    fetchedAt: new Date(0).toISOString(),
  },
  worldReady: false,
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const ui = {
  getState(): State {
    return state;
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  setHud(hud: HudKind | null) {
    state = { ...state, hud };
    emit();
  },

  setPrompt(prompt: PromptState) {
    state = { ...state, prompt };
    emit();
  },

  openPanel(panel: NonNullable<PanelState>) {
    state = { ...state, panel, prompt: null };
    emit();
  },

  closePanel() {
    if (!state.panel) return;
    state = { ...state, panel: null };
    emit();
  },

  openExplorer() {
    state = { ...state, explorer: { open: true }, prompt: null };
    emit();
  },

  closeExplorer() {
    if (!state.explorer) return;
    state = { ...state, explorer: null };
    emit();
  },

  openDialogue(dialogue: NonNullable<DialogueState>) {
    state = { ...state, dialogue, prompt: null };
    emit();
  },

  closeDialogue() {
    if (!state.dialogue) return;
    state = { ...state, dialogue: null };
    emit();
  },

  openChat(chat: NonNullable<ChatState>) {
    state = { ...state, chat, dialogue: null, prompt: null };
    emit();
  },

  closeChat() {
    if (!state.chat) return;
    state = { ...state, chat: null };
    emit();
  },

  openInvite() {
    state = { ...state, invite: { open: true }, prompt: null };
    emit();
  },

  closeInvite() {
    if (!state.invite) return;
    state = { ...state, invite: null };
    emit();
  },

  openShareImage() {
    state = { ...state, shareImage: { open: true }, prompt: null };
    emit();
  },

  closeShareImage() {
    if (!state.shareImage) return;
    state = { ...state, shareImage: null };
    emit();
  },

  openInstructions() {
    if (state.instructions) return;
    state = { ...state, instructions: { open: true }, prompt: null };
    emit();
  },

  closeInstructions() {
    if (!state.instructions) return;
    state = { ...state, instructions: null };
    emit();
  },

  openCommandBar() {
    if (state.commandBar) return;
    state = { ...state, commandBar: { open: true }, prompt: null };
    emit();
  },

  closeCommandBar() {
    if (!state.commandBar) return;
    state = { ...state, commandBar: null };
    emit();
  },

  toggleCommandBar() {
    if (state.commandBar) {
      state = { ...state, commandBar: null };
    } else {
      state = { ...state, commandBar: { open: true }, prompt: null };
    }
    emit();
  },

  openFeed() {
    if (state.feed) return;
    state = { ...state, feed: { open: true } };
    emit();
  },

  closeFeed() {
    if (!state.feed) return;
    state = { ...state, feed: null };
    emit();
  },

  toggleFeed() {
    if (state.feed) {
      state = { ...state, feed: null };
    } else {
      state = { ...state, feed: { open: true } };
    }
    emit();
  },

  setProximity(proximity: ProximityState) {
    // No-op if it's the same target — avoids re-renders during the every-
    // frame proximity check.
    const cur = state.proximity;
    if (!proximity && !cur) return;
    if (
      proximity &&
      cur &&
      proximity.participantKey === cur.participantKey &&
      proximity.name === cur.name &&
      proximity.character === cur.character
    ) {
      return;
    }
    state = { ...state, proximity };
    emit();
  },

  openDm(dm: NonNullable<DmState>) {
    state = { ...state, dm, prompt: null };
    emit();
  },

  closeDm() {
    if (!state.dm) return;
    state = { ...state, dm: null };
    emit();
  },

  setSuggestions(next: Partial<SuggestionsState>) {
    state = {
      ...state,
      suggestions: { ...state.suggestions, ...next },
    };
    emit();
  },

  setWorldReady(ready: boolean) {
    if (state.worldReady === ready) return;
    state = { ...state, worldReady: ready };
    emit();
  },

  openSuggestions() {
    if (state.suggestions.open) return;
    state = {
      ...state,
      suggestions: { ...state.suggestions, open: true },
      prompt: null,
    };
    emit();
  },

  closeSuggestions() {
    if (!state.suggestions.open) return;
    state = {
      ...state,
      suggestions: { ...state.suggestions, open: false },
    };
    emit();
  },

  // Locally remove a suggestion after the API confirmed approve/decline,
  // so the sidebar updates instantly without waiting for the next poll.
  removeSuggestion(id: string) {
    const list = state.suggestions.list.filter((s) => s.id !== id);
    if (list.length === state.suggestions.list.length) return;
    state = {
      ...state,
      suggestions: {
        ...state.suggestions,
        list,
        count: list.length,
      },
    };
    emit();
  },

  // Convenience for kaplay player movement code: pause the world while a
  // modal-style surface is open so SPACE/ESC/typing-into-forms don't
  // double-trigger. Ambient overlays like the NPC dialogue intentionally
  // skip this so the player can still walk away and have the overlay
  // auto-close on departure (see autoTrigger in interior.ts).
  isPaused(): boolean {
    return (
      state.panel !== null ||
      state.explorer !== null ||
      state.chat !== null ||
      state.invite !== null ||
      state.shareImage !== null ||
      state.instructions !== null ||
      state.commandBar !== null ||
      state.dm !== null ||
      state.suggestions.open
    );
  },
};
