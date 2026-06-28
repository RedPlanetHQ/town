// Top-level React component for the chat creator surface.
//
// Layout:
//   ┌─ chat scroll ────────────────────────┐
//   │ user / assistant / tool-call rows    │
//   └──────────────────────────────────────┘
//   pending ribbon
//   > input
//   status bar
//
// Modes:
//   • input       — user is typing
//   • streaming   — POST in flight; chat scroll updates as chunks arrive
//   • diff        — overlay listing staged changes; user picks approve / clear
//   • applying    — deploy in progress (driven by the parent's onApply
//                   callback); we show a "Applying…" status until the
//                   promise resolves.
//
// Slash commands:
//   /clear → POST { action: "clear-conversation" }, then reset history
//   /help  → render an inline help block
//
// Key bindings:
//   Enter        → submit
//   ↓ (empty)    → open diff overlay
//   Ctrl+C       → exit

import React, { useCallback, useEffect, useReducer, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";

import { DiffModal, type PendingChange } from "./diff-modal.js";
import { Header } from "./header.js";
import { StatusBar } from "./status-bar.js";
import { ToolCallView, type ToolCallState } from "./tool-call.js";
import { streamCreator, type StreamChunk } from "./stream-events.js";

// Pulled from packages/town-cli/package.json. Hard-coded for now so the
// header doesn't pull in a JSON import (and so we don't need package.json
// in `files` of the published tarball). Bump in lockstep with the
// version field there.
const CLI_VERSION = "0.2.0";
const LABEL_COLOR = "rgb(232,143,106)"; // warm orange used by You:/Creator: labels

// Slash-command registry. Order = display order in the suggestion list.
// Keep this tiny — slash commands are for chat-surface controls only,
// not town-content actions (those happen via tool calls).
interface SlashCommand {
  name: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "drop the current conversation + start fresh" },
  { name: "buildings", description: "list every building in the town" },
  { name: "npcs", description: "list every NPC (Enter to see their full prompt)" },
  { name: "help", description: "show key bindings + slash commands" },
];

// Placeholder shown inside the input box when the buffer is empty.
// Hints the three things the user can do without explaining everything:
// freeform message, slash commands, @-mention an entity.
const INPUT_PLACEHOLDER =
  "describe the town · / for commands · @ to mention an NPC or building";

// -----------------------------------------------------------------------------
// Entity types — buildings + NPCs hydrated from /api/creator
// -----------------------------------------------------------------------------

export interface BuildingEntity {
  id: string;
  plotKey: string;
  variantId: string | null;
  label: string | null;
}

export interface NpcEntity {
  id: string;
  buildingId: string;
  slotId: string;
  name: string;
  description: string;
  prompt: string;
}

// Shown at the top of an empty chat. Solo-Leveling-style narrator
// voice: brief, declarative, slightly mythic. The town name is
// interpolated by the caller so each town gets a personalized line.
/** Whether the current input buffer should display the slash-command
 *  suggestion list. True when the buffer starts with `/` and no space
 *  has been typed yet — once the user hits space, they're either
 *  committing the command or typing args (none of the current
 *  commands take args, so this also means "hide the menu"). */
function isSlashSuggesting(buffer: string): boolean {
  if (!buffer.startsWith("/")) return false;
  return !buffer.includes(" ");
}

/** Filter SLASH_COMMANDS by the prefix typed after the leading `/`.
 *  Empty prefix shows all. Case-insensitive substring match — same UX
 *  as core-cli's filter. */
function filterSlashCommands(buffer: string): SlashCommand[] {
  if (!isSlashSuggesting(buffer)) return [];
  const prefix = buffer.slice(1).toLowerCase();
  if (prefix === "") return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) =>
    c.name.toLowerCase().includes(prefix),
  );
}

/** Extract the active @-mention prefix from the buffer if the cursor
 *  is currently typing one. We treat `@` after the start-of-buffer or
 *  after a whitespace as opening the mention, and ride it until the
 *  user hits whitespace. Returns the partial token (without the @),
 *  or null if no active mention. */
function extractMentionPrefix(buffer: string): string | null {
  const atIdx = buffer.lastIndexOf("@");
  if (atIdx === -1) return null;
  // Only valid if @ is at the start of buffer or follows whitespace.
  if (atIdx > 0 && !/\s/.test(buffer[atIdx - 1] ?? "")) return null;
  const tail = buffer.slice(atIdx + 1);
  // Whitespace closes the mention.
  if (/\s/.test(tail)) return null;
  return tail;
}

export type MentionItem =
  | { kind: "building"; id: string; label: string; sub: string }
  | { kind: "npc"; id: string; label: string; sub: string };

/** Flatten buildings + NPCs into a single suggestion list, then filter
 *  by the typed prefix. Buildings first (named or by id), then NPCs.
 *  Case-insensitive substring on the display label. */
function filterMentions(
  prefix: string | null,
  buildings: BuildingEntity[],
  npcs: NpcEntity[],
): MentionItem[] {
  if (prefix === null) return [];
  const lower = prefix.toLowerCase();
  const items: MentionItem[] = [
    ...buildings.map<MentionItem>((b) => ({
      kind: "building",
      id: b.id,
      label: b.label ?? b.id,
      sub: b.plotKey,
    })),
    ...npcs.map<MentionItem>((n) => ({
      kind: "npc",
      id: n.id,
      label: n.name,
      sub: `in ${n.buildingId}${n.slotId ? `:${n.slotId}` : ""}`,
    })),
  ];
  if (lower === "") return items.slice(0, 20);
  return items
    .filter(
      (it) =>
        it.label.toLowerCase().includes(lower) ||
        it.id.toLowerCase().includes(lower),
    )
    .slice(0, 20);
}

/** Replace the in-progress mention with the picked entity's name. */
function applyMention(buffer: string, item: MentionItem): string {
  const atIdx = buffer.lastIndexOf("@");
  if (atIdx === -1) return buffer;
  // Slug-ify the label so the inserted token has no whitespace —
  // otherwise extractMentionPrefix would treat the rest as a new
  // mention. Spaces become hyphens; the model can read either fine.
  const slug = item.label.replace(/\s+/g, "-");
  return `${buffer.slice(0, atIdx)}@${slug} `;
}

function defaultKickoff(townName: string | undefined): string {
  // Plain text — Ink doesn't parse markdown, so wrapping the name in
  // **…** would render literal asterisks. The italic/bold is conveyed
  // by the warm-orange "Creator:" label on the row above.
  const target = townName ? townName : "this town";
  return `I am the Town Creator, keeper of plots and people. Tell me what ${target} should be.`;
}

// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------

export interface ChatAppProps {
  townUrl: string;
  pat: string;
  townSlug: string;
  cwd: string;
  /** Initial messages to hydrate the scroll. Each entry is rendered the
   *  same way a live turn would render — text rows for user/assistant,
   *  tool-call rows for staged mutations. The CLI seeds this from
   *  `GET /api/creator?slug=…` on launch when the endpoint exists. */
  initialMessages?: ChatRow[];
  initialPendingChanges?: PendingChange[];
  initialAura?: { current: number; max: number };
  initialBuildings?: BuildingEntity[];
  initialNpcs?: NpcEntity[];
  /** Optional kickoff line shown as if the assistant said it. When
   *  unset and the conversation has no history, we render
   *  `defaultKickoff(townName)` instead so a fresh chat always starts
   *  with the Town Creator's greeting. */
  kickoff?: string;
  /** Human-readable town name interpolated into the default kickoff.
   *  Optional — the kickoff falls back to "this town" when missing. */
  townName?: string;
  /** Apply approved changes locally, then redeploy in the background.
   *  The promise resolves as soon as the LOCAL apply is done — the
   *  redeploy is reported through `hooks.onDeployPhase` so the chat
   *  surface can keep showing status near the pending area without
   *  blocking the input. The optional return is the latest aura values
   *  (deploy may have changed them). */
  onApply?: (
    changes: PendingChange[],
    hooks: {
      onDeployPhase: (
        phase: "deploying" | "deployed" | "failed",
        info?: {
          message?: string;
          aura?: { current: number; max: number };
        },
      ) => void;
    },
  ) => Promise<void>;
  /** Drop the server-side pending queue. Called when the user picks
   *  "Clear" in the diff modal. */
  onClearChanges?: () => Promise<void>;
}

export type ChatRow =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; call: ToolCallState }
  | { type: "system"; text: string }
  | { type: "error"; text: string };

// -----------------------------------------------------------------------------
// Internal state machine
// -----------------------------------------------------------------------------

interface State {
  rows: ChatRow[];
  /** Number of rows committed to the Static scroll (read-only after this
   *  point). Anything past this index is "live" — re-rendered as stream
   *  chunks arrive. begin-stream bumps this to include the user turn;
   *  end-stream snapshots the rest of the rows array. */
  finalizedRowCount: number;
  pending: PendingChange[];
  aura: { current: number; max: number };
  /** Active conversation id, updated when `/clear` opens a fresh one.
   *  Surfaced for debugging; the server still owns conversation rotation
   *  so the next turn picks up the active row by (townId, userId). */
  conversationId?: string;
  mode:
    | "input"
    | "streaming"
    | "diff"
    | "applying"
    | "buildings-view"
    | "npcs-view";
  inputBuffer: string;
  /** Hydrated entity lists shown in /buildings, /npcs, and the
   *  @-mention autocomplete. Refreshed on launch + after each
   *  successful deploy. */
  buildings: BuildingEntity[];
  npcs: NpcEntity[];
  /** Selection state inside the modal entity views. Reset on
   *  re-entry. `npcExpanded` flips the row from one-line summary to
   *  the full prompt so the user can read it without leaving the TUI. */
  entityIndex: number;
  npcExpanded: boolean;
  mentionSelectedIndex: number;
  /** Active tool-call buffers keyed by toolCallId — referenced both from
   *  the scroll (for rendering) and the chunk handler (for accumulation).
   *  We index here to keep handlers O(1). */
  activeCalls: Map<string, ToolCallState>;
  /** Transcript-wide expansion toggle. Ctrl+O flips this and every
   *  tool call in the scroll renders accordingly — matches the CORE
   *  CLI affordance. */
  toolsExpanded: boolean;
  /** Session counter — bumped on `/clear`. Used to namespace the keys
   *  passed to <Static>, so Ink re-renders rows after a clear instead
   *  of treating them as already-committed (Static caches by key and
   *  never un-renders). We also write a terminal clear sequence at the
   *  same time to wipe the alt-screen buffer. */
  clearNonce: number;
  /** Index into the active slash-command suggestion list. Reset to 0
   *  whenever the suggestion list changes; ↑/↓ moves it (wraps);
   *  Tab/Enter accepts. */
  slashSelectedIndex: number;
  /** Inline status shown in the pending-changes ribbon while a
   *  background deploy is in flight. `null` means no deploy active;
   *  otherwise the string is rendered verbatim ("deploying…",
   *  "deployed", or an error line). The chat surface clears this a
   *  beat after success so it gracefully fades back to "no pending
   *  changes". */
  deployStatus: string | null;
  statusMessage?: string;
}

type Action =
  | { type: "set-input"; value: string }
  | { type: "slash-nav"; delta: number }
  | { type: "set-deploy-status"; status: string | null }
  | {
      type: "set-entities";
      buildings: BuildingEntity[];
      npcs: NpcEntity[];
    }
  | { type: "open-entity-view"; which: "buildings-view" | "npcs-view" }
  | { type: "close-entity-view" }
  | { type: "entity-nav"; delta: number }
  | { type: "toggle-npc-expanded" }
  | { type: "mention-nav"; delta: number }
  | { type: "append-row"; row: ChatRow }
  | { type: "begin-stream"; userText: string }
  | { type: "end-stream" }
  | { type: "stream-chunk"; chunk: StreamChunk }
  | { type: "set-pending"; pending: PendingChange[] }
  | { type: "set-aura"; aura: { current: number; max: number } }
  | { type: "open-diff" }
  | { type: "close-diff" }
  | { type: "enter-applying"; message: string }
  | { type: "exit-applying"; message?: string }
  | { type: "toggle-tools-expanded" }
  | { type: "reset-conversation"; conversationId?: string }
  | { type: "set-status"; message?: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "set-input":
      // Reset both suggestion selections whenever the buffer changes
      // — the available list might have shrunk, so a stale
      // selectedIndex could point past the end.
      return {
        ...state,
        inputBuffer: action.value,
        slashSelectedIndex: 0,
        mentionSelectedIndex: 0,
      };
    case "slash-nav": {
      const list = filterSlashCommands(state.inputBuffer);
      if (list.length === 0) return state;
      const len = list.length;
      const next = (state.slashSelectedIndex + action.delta + len) % len;
      return { ...state, slashSelectedIndex: next };
    }
    case "set-deploy-status":
      return { ...state, deployStatus: action.status };
    case "set-entities":
      return {
        ...state,
        buildings: action.buildings,
        npcs: action.npcs,
      };
    case "open-entity-view":
      return {
        ...state,
        mode: action.which,
        entityIndex: 0,
        npcExpanded: false,
      };
    case "close-entity-view":
      return { ...state, mode: "input" };
    case "entity-nav": {
      const len =
        state.mode === "buildings-view"
          ? state.buildings.length
          : state.mode === "npcs-view"
            ? state.npcs.length
            : 0;
      if (len === 0) return state;
      const next = (state.entityIndex + action.delta + len) % len;
      return { ...state, entityIndex: next, npcExpanded: false };
    }
    case "toggle-npc-expanded":
      return { ...state, npcExpanded: !state.npcExpanded };
    case "mention-nav": {
      // The selectable list is recomputed on render; here we just
      // shift the index and let the renderer clamp/wrap to the live
      // mention list size.
      const next = state.mentionSelectedIndex + action.delta;
      return {
        ...state,
        mentionSelectedIndex: next < 0 ? 0 : next,
      };
    }
    case "append-row": {
      const nextRows = [...state.rows, action.row];
      // Appended outside a stream → finalize immediately so Static
      // renders it.
      return {
        ...state,
        rows: nextRows,
        finalizedRowCount: nextRows.length,
      };
    }
    case "begin-stream": {
      const nextRows = [...state.rows, { type: "user" as const, text: action.userText }];
      return {
        ...state,
        rows: nextRows,
        // User turn is final the instant we add it. The assistant +
        // tool rows that follow live in the "live" tail until
        // end-stream snapshots them.
        finalizedRowCount: nextRows.length,
        mode: "streaming",
        inputBuffer: "",
        statusMessage: undefined,
      };
    }
    case "end-stream":
      return {
        ...state,
        mode: "input",
        // Promote everything streamed during this turn into the Static
        // scroll so future renders skip re-computing them.
        finalizedRowCount: state.rows.length,
        activeCalls: new Map(),
      };
    case "stream-chunk":
      return applyChunk(state, action.chunk);
    case "set-pending":
      return { ...state, pending: action.pending };
    case "set-aura":
      return { ...state, aura: action.aura };
    case "open-diff":
      return { ...state, mode: "diff" };
    case "close-diff":
      return { ...state, mode: "input" };
    case "enter-applying":
      return { ...state, mode: "applying", statusMessage: action.message };
    case "exit-applying":
      return {
        ...state,
        mode: "input",
        statusMessage: action.message,
        pending: [],
      };
    case "toggle-tools-expanded":
      return { ...state, toolsExpanded: !state.toolsExpanded };
    case "reset-conversation":
      return {
        ...state,
        rows: [],
        finalizedRowCount: 0,
        pending: [],
        conversationId: action.conversationId ?? state.conversationId,
        mode: "input",
        statusMessage: "Conversation cleared.",
        activeCalls: new Map(),
        toolsExpanded: false,
        // Bump so <Static> keys differ from the prior conversation —
        // otherwise Ink keeps the old rows committed even though state
        // shows []. The submit handler also writes the alt-screen
        // clear sequence so the OS terminal buffer matches.
        clearNonce: state.clearNonce + 1,
      };
    case "set-status":
      return { ...state, statusMessage: action.message };
    default:
      return state;
  }
}

function applyChunk(state: State, chunk: StreamChunk): State {
  switch (chunk.type) {
    case "text-delta": {
      // Append onto the most recent assistant row (or create one).
      const rows = [...state.rows];
      const last = rows[rows.length - 1];
      if (last && last.type === "assistant") {
        rows[rows.length - 1] = { type: "assistant", text: last.text + chunk.delta };
      } else {
        rows.push({ type: "assistant", text: chunk.delta });
      }
      return { ...state, rows };
    }
    case "tool-input-start": {
      const call: ToolCallState = {
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        partialInput: "",
        done: false,
      };
      const activeCalls = new Map(state.activeCalls);
      activeCalls.set(chunk.toolCallId, call);
      return {
        ...state,
        rows: [...state.rows, { type: "tool", call }],
        activeCalls,
      };
    }
    case "tool-input-delta": {
      const activeCalls = new Map(state.activeCalls);
      const existing = activeCalls.get(chunk.toolCallId);
      if (!existing) return state;
      const next: ToolCallState = {
        ...existing,
        partialInput: (existing.partialInput ?? "") + chunk.inputTextDelta,
      };
      activeCalls.set(chunk.toolCallId, next);
      return { ...state, activeCalls, rows: replaceToolRow(state.rows, next) };
    }
    case "tool-input-available": {
      const activeCalls = new Map(state.activeCalls);
      const existing =
        activeCalls.get(chunk.toolCallId) ?? {
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          done: false,
        };
      const next: ToolCallState = {
        ...existing,
        toolName: chunk.toolName,
        input: chunk.input,
        partialInput: undefined,
      };
      activeCalls.set(chunk.toolCallId, next);
      const rows = state.rows.some(
        (r) => r.type === "tool" && r.call.toolCallId === chunk.toolCallId,
      )
        ? replaceToolRow(state.rows, next)
        : [...state.rows, { type: "tool" as const, call: next }];
      return { ...state, activeCalls, rows };
    }
    case "tool-output-available": {
      const activeCalls = new Map(state.activeCalls);
      const existing = activeCalls.get(chunk.toolCallId);
      if (!existing) return state;
      const next: ToolCallState = {
        ...existing,
        output: chunk.output,
        done: true,
      };
      activeCalls.set(chunk.toolCallId, next);
      // Surface auraRemaining from mutation tools into the status bar.
      let aura = state.aura;
      if (
        chunk.output &&
        typeof chunk.output === "object" &&
        "auraRemaining" in (chunk.output as Record<string, unknown>)
      ) {
        const remaining = (chunk.output as { auraRemaining?: unknown })
          .auraRemaining;
        if (typeof remaining === "number") {
          aura = { ...aura, current: remaining };
        }
      }
      return { ...state, activeCalls, rows: replaceToolRow(state.rows, next), aura };
    }
    case "tool-output-error": {
      const activeCalls = new Map(state.activeCalls);
      const existing = activeCalls.get(chunk.toolCallId);
      if (!existing) return state;
      const next: ToolCallState = {
        ...existing,
        error: chunk.errorText,
        done: true,
      };
      activeCalls.set(chunk.toolCallId, next);
      return { ...state, activeCalls, rows: replaceToolRow(state.rows, next) };
    }
    case "error":
      return {
        ...state,
        rows: [...state.rows, { type: "error", text: chunk.errorText }],
      };
    default:
      return state;
  }
}

function replaceToolRow(rows: ChatRow[], next: ToolCallState): ChatRow[] {
  const out = rows.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const r = out[i]!;
    if (r.type === "tool" && r.call.toolCallId === next.toolCallId) {
      out[i] = { type: "tool", call: next };
      return out;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function ChatApp(props: ChatAppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [state, dispatch] = useReducer(reducer, undefined, () => {
    const initialRows = props.initialMessages ?? [];
    return {
      rows: initialRows,
      // Hydrated messages render in the static scroll from the start —
      // they were finalized in a previous session.
      finalizedRowCount: initialRows.length,
      pending: props.initialPendingChanges ?? [],
      aura: props.initialAura ?? { current: 1000, max: 1000 },
      mode: "input" as const,
      inputBuffer: "",
      activeCalls: new Map(),
      toolsExpanded: false,
      clearNonce: 0,
      slashSelectedIndex: 0,
      deployStatus: null,
      buildings: props.initialBuildings ?? [],
      npcs: props.initialNpcs ?? [],
      entityIndex: 0,
      npcExpanded: false,
      mentionSelectedIndex: 0,
      statusMessage: undefined,
    };
  });

  // Stash latest pending changes from any tool-output that brings them.
  // The mutation tools don't echo the queue, so we re-query through the
  // turn boundary via the chunk count instead — see endStreamRefresh.
  const [pendingPollNonce, setPendingPollNonce] = useState(0);

  // Greet on launch: explicit kickoff prop wins; otherwise fall back
  // to the default Town Creator greeting only when the conversation is
  // empty (so hydrated history doesn't get a stale greeting prepended).
  // Fires exactly once — `[]` deps mean re-renders won't re-append.
  useEffect(() => {
    const text = props.kickoff;
    if (text) {
      dispatch({ type: "append-row", row: { type: "assistant", text } });
      return;
    }
    if ((props.initialMessages?.length ?? 0) === 0) {
      dispatch({
        type: "append-row",
        row: { type: "assistant", text: defaultKickoff(props.townName) },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On every CLI launch:
  //   1. Archive the active conversation + start a fresh one (the user
  //      asked for "new conversation per launch"; chat history doesn't
  //      bleed across sessions). Note: pending changes survive because
  //      they live on Town.pendingChanges, NOT on the conversation row.
  //   2. Hydrate aura + pending from the server so the status bar
  //      reflects reality before the first turn (otherwise we sit on
  //      the default 1000/1000 placeholder).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. Archive the previous conversation. Server creates a new
        //    one and returns its id; we don't actually need it client-
        //    side because the next POST will resolve the active row by
        //    (townId, userId).
        await fetch(`${props.townUrl}/api/creator`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${props.pat}`,
          },
          body: JSON.stringify({
            townSlug: props.townSlug,
            action: "clear-conversation",
          }),
        });
        if (cancelled) return;

        // 2. Hydrate aura + pending + entities. Pending lives on the
        //    Town row so it's preserved across the clear above.
        //    Buildings + NPCs power the /buildings + /npcs views and
        //    the @-mention autocomplete.
        const res = await fetch(
          `${props.townUrl}/api/creator?slug=${encodeURIComponent(props.townSlug)}`,
          { headers: { authorization: `Bearer ${props.pat}` } },
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          pendingChanges?: PendingChange[];
          aura?: { current: number; max: number };
          buildings?: BuildingEntity[];
          npcs?: NpcEntity[];
        };
        if (cancelled) return;
        if (body.aura) dispatch({ type: "set-aura", aura: body.aura });
        if (body.pendingChanges) {
          dispatch({ type: "set-pending", pending: body.pendingChanges });
        }
        if (body.buildings || body.npcs) {
          dispatch({
            type: "set-entities",
            buildings: body.buildings ?? [],
            npcs: body.npcs ?? [],
          });
        }
      } catch {
        // tolerated — the status bar will refresh after the first turn.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After each turn finishes, ask the server for the up-to-date queue
  // + aura + entities. Tool outputs surface aura inline, but the queue
  // + entity lists need a round-trip — the model stages or the deploy
  // applies, we render the call, then refresh.
  useEffect(() => {
    if (state.mode !== "input" || pendingPollNonce === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${props.townUrl}/api/creator?slug=${encodeURIComponent(props.townSlug)}`,
          { headers: { authorization: `Bearer ${props.pat}` } },
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          pendingChanges?: PendingChange[];
          aura?: { current: number; max: number };
          buildings?: BuildingEntity[];
          npcs?: NpcEntity[];
        };
        if (cancelled) return;
        if (body.pendingChanges) {
          dispatch({ type: "set-pending", pending: body.pendingChanges });
        }
        if (body.aura) {
          dispatch({ type: "set-aura", aura: body.aura });
        }
        if (body.buildings || body.npcs) {
          dispatch({
            type: "set-entities",
            buildings: body.buildings ?? [],
            npcs: body.npcs ?? [],
          });
        }
      } catch {
        // network blips are fine — we'll re-poll on the next turn.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingPollNonce, state.mode, props.townUrl, props.townSlug, props.pat]);

  const submitMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (trimmed === "/help") {
        dispatch({
          type: "append-row",
          row: {
            type: "system",
            text: helpText(),
          },
        });
        dispatch({ type: "set-input", value: "" });
        return;
      }

      if (trimmed === "/buildings") {
        dispatch({ type: "set-input", value: "" });
        dispatch({ type: "open-entity-view", which: "buildings-view" });
        return;
      }

      if (trimmed === "/npcs") {
        dispatch({ type: "set-input", value: "" });
        dispatch({ type: "open-entity-view", which: "npcs-view" });
        return;
      }

      if (trimmed === "/clear") {
        // Slash-command — never send as a chat message. Archive the
        // server-side conversation, then drop both the local message
        // history and the pending-change queue (the new conversation
        // starts with an empty queue by definition).
        dispatch({ type: "set-input", value: "" });
        let nextConvoId: string | undefined;
        try {
          const res = await fetch(`${props.townUrl}/api/creator`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${props.pat}`,
            },
            body: JSON.stringify({
              townSlug: props.townSlug,
              action: "clear-conversation",
            }),
          });
          if (res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              conversationId?: string;
            };
            nextConvoId = body.conversationId;
          }
        } catch {
          // server unreachable — still reset locally so the user can
          // keep working offline-ish.
        }
        // Wipe the alt-screen + home cursor so the prior conversation's
        // already-committed Static rows disappear from the terminal.
        // State alone isn't enough — Ink's <Static> writes rows to
        // stdout once and never un-renders them. The clearNonce bump
        // inside reset-conversation pairs with this so the new render
        // uses fresh keys.
        process.stdout.write("\x1b[2J\x1b[H");
        dispatch({ type: "reset-conversation", conversationId: nextConvoId });
        // Re-show the default Town Creator greeting on the fresh
        // conversation, matching the initial-launch UX.
        const greet = props.kickoff ?? defaultKickoff(props.townName);
        dispatch({
          type: "append-row",
          row: { type: "assistant", text: greet },
        });
        return;
      }

      dispatch({ type: "begin-stream", userText: trimmed });

      try {
        const { chunks } = await streamCreator({
          townUrl: props.townUrl,
          pat: props.pat,
          townSlug: props.townSlug,
          message: trimmed,
        });
        for await (const chunk of chunks) {
          dispatch({ type: "stream-chunk", chunk });
        }
      } catch (err) {
        dispatch({
          type: "append-row",
          row: {
            type: "error",
            text: `stream failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      } finally {
        dispatch({ type: "end-stream" });
        setPendingPollNonce((n) => n + 1);
      }
    },
    [props.townUrl, props.pat, props.townSlug],
  );

  const onApprove = useCallback(async () => {
    if (!props.onApply) {
      dispatch({
        type: "exit-applying",
        message: "No apply handler wired — nothing to do.",
      });
      return;
    }
    // Phase callbacks come from the background deploy. We render them
    // inside the pending-changes ribbon (`deployStatus`) so the chat
    // stays usable while the deploy is in flight — no alt-screen
    // takeover, no clack-prompts banners shredding the Ink frame.
    dispatch({ type: "enter-applying", message: "Applying changes…" });
    try {
      await props.onApply(state.pending, {
        onDeployPhase: (phase, info) => {
          if (info?.aura) dispatch({ type: "set-aura", aura: info.aura });
          if (phase === "deploying") {
            dispatch({ type: "set-deploy-status", status: "deploying…" });
          } else if (phase === "deployed") {
            dispatch({ type: "set-deploy-status", status: "deployed" });
            // Fade the "deployed" pill out after a short beat so the
            // ribbon settles into "no pending changes."
            setTimeout(
              () => dispatch({ type: "set-deploy-status", status: null }),
              2200,
            );
          } else {
            dispatch({
              type: "set-deploy-status",
              status: `deploy failed${info?.message ? `: ${info.message}` : ""}`,
            });
          }
        },
      });
      dispatch({
        type: "exit-applying",
        message: "Applied locally — town deploying in background.",
      });
    } catch (err) {
      dispatch({
        type: "exit-applying",
        message: `Apply failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, [props, state.pending]);

  const onRemoveChange = useCallback(
    async (changeId: string) => {
      try {
        const res = await fetch(`${props.townUrl}/api/creator`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${props.pat}`,
          },
          body: JSON.stringify({
            townSlug: props.townSlug,
            action: "remove-change",
            changeId,
          }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          pendingChanges?: PendingChange[];
        };
        if (body.pendingChanges) {
          dispatch({ type: "set-pending", pending: body.pendingChanges });
        }
      } catch {
        // tolerated — the next turn will refresh anyway.
      }
    },
    [props.townUrl, props.pat, props.townSlug],
  );

  const onClear = useCallback(async () => {
    dispatch({ type: "enter-applying", message: "Clearing queue…" });
    try {
      if (props.onClearChanges) {
        await props.onClearChanges();
      } else {
        await fetch(`${props.townUrl}/api/creator`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${props.pat}`,
          },
          body: JSON.stringify({
            townSlug: props.townSlug,
            action: "clear-changes",
          }),
        });
      }
      dispatch({
        type: "exit-applying",
        message: "Cleared pending changes.",
      });
    } catch (err) {
      dispatch({
        type: "exit-applying",
        message: `Clear failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, [props]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        exit();
        return;
      }
      if (state.mode === "applying") return;

      if (state.mode === "diff") {
        // diff handles its own bindings — fall through.
        return;
      }

      if (state.mode === "buildings-view" || state.mode === "npcs-view") {
        // Modal entity view. Bindings: ↑/↓ navigate, Enter expands the
        // selected NPC's prompt (npcs-view only), Esc closes back to
        // input. Ctrl+C exit already handled above.
        if (key.escape) {
          dispatch({ type: "close-entity-view" });
          return;
        }
        if (key.upArrow) {
          dispatch({ type: "entity-nav", delta: -1 });
          return;
        }
        if (key.downArrow) {
          dispatch({ type: "entity-nav", delta: +1 });
          return;
        }
        if (key.return && state.mode === "npcs-view") {
          dispatch({ type: "toggle-npc-expanded" });
          return;
        }
        return;
      }

      if (state.mode === "streaming") {
        // Streaming is non-interruptible for now; flag tooling backlog.
        return;
      }

      // Mode is 'input' from here on.

      // @-mention suggestions intercept arrows + Tab + Enter when the
      // user is mid-mention. Built BEFORE slash-suggestions so a buffer
      // like "@" doesn't get treated as a slash list (it can't —
      // different leading char — but the order makes the priority
      // explicit).
      const mentionPrefix = extractMentionPrefix(state.inputBuffer);
      const mentionList = filterMentions(
        mentionPrefix,
        state.buildings,
        state.npcs,
      );
      const mentionOpen = mentionList.length > 0;
      if (mentionOpen) {
        if (key.upArrow) {
          dispatch({ type: "mention-nav", delta: -1 });
          return;
        }
        if (key.downArrow) {
          dispatch({ type: "mention-nav", delta: +1 });
          return;
        }
        const wrappedIndex =
          mentionList.length > 0
            ? Math.min(state.mentionSelectedIndex, mentionList.length - 1)
            : 0;
        const pick = mentionList[wrappedIndex];
        if (key.tab && pick) {
          dispatch({
            type: "set-input",
            value: applyMention(state.inputBuffer, pick),
          });
          return;
        }
        if (key.return && pick) {
          // Enter accepts the mention into the buffer; user keeps
          // typing or hits Enter again to submit. This matches
          // core-cli's @-completion ergonomics — selection completes,
          // doesn't auto-send.
          dispatch({
            type: "set-input",
            value: applyMention(state.inputBuffer, pick),
          });
          return;
        }
        // Typing keys fall through so the user can keep narrowing.
      }

      // Slash-command suggestions intercept arrows + Tab + Enter when
      // visible. Order matters: arrows for nav, Tab to accept the
      // selection without submitting, Enter to accept-AND-submit.
      const slashList = filterSlashCommands(state.inputBuffer);
      const slashOpen = !mentionOpen && slashList.length > 0;
      if (slashOpen) {
        if (key.upArrow) {
          dispatch({ type: "slash-nav", delta: -1 });
          return;
        }
        if (key.downArrow) {
          dispatch({ type: "slash-nav", delta: +1 });
          return;
        }
        if (key.tab) {
          const pick = slashList[state.slashSelectedIndex] ?? slashList[0];
          if (pick) {
            dispatch({ type: "set-input", value: `/${pick.name}` });
          }
          return;
        }
        if (key.return) {
          const pick = slashList[state.slashSelectedIndex] ?? slashList[0];
          if (pick) {
            void submitMessage(`/${pick.name}`);
          }
          return;
        }
        // Fall through for typing keys so the user can keep narrowing.
      }

      if (key.return) {
        const text = state.inputBuffer;
        if (!text.trim()) return;
        void submitMessage(text);
        return;
      }
      if (
        key.downArrow &&
        state.inputBuffer === "" &&
        state.pending.length > 0
      ) {
        // ↓ only opens the diff overlay when there's actually something
        // staged. With zero pending we ignore the keystroke so the
        // status-bar hint ("no pending changes") doesn't lie.
        dispatch({ type: "open-diff" });
        return;
      }
      if (key.ctrl && input === "o") {
        // Flip the transcript-wide tool-call expansion so every tool
        // row in the scroll expands or collapses together — matches the
        // CORE CLI affordance and works regardless of input contents.
        dispatch({ type: "toggle-tools-expanded" });
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: "set-input", value: state.inputBuffer.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.escape) {
        dispatch({ type: "set-input", value: state.inputBuffer + input });
      }
    },
    { isActive: true },
  );

  const cols = Math.max(20, stdout?.columns ?? 80);

  // Ink's <Static> only re-renders items it hasn't seen before — perfect
  // for FINALIZED rows (already-streamed assistant text, completed tool
  // calls) but wrong for the LIVE row currently being built by the
  // stream (text-delta chunks would otherwise be silently dropped).
  // Split: rows[0..finalizedRowCount] → Static (renders once, stays);
  // rows[finalizedRowCount..] → dynamic below, re-renders every chunk.
  // end-stream snapshots the entire live tail into Static.
  const finalizedRows = state.rows.slice(0, state.finalizedRowCount);
  const liveRows = state.rows.slice(state.finalizedRowCount);
  // Namespace keys with clearNonce — Ink's <Static> caches by key and
  // never un-renders. After /clear we bump clearNonce so the next
  // batch lands with fresh keys and gets drawn.
  const keyPrefix = `s${state.clearNonce}`;
  const staticItems: Array<{ key: string; node: React.ReactElement }> = [
    {
      key: `${keyPrefix}-header`,
      node: <Header version={CLI_VERSION} />,
    },
    ...finalizedRows.map((row, i) => ({
      key: `${keyPrefix}-row-${i}`,
      node: (
        <ChatRowView
          row={row}
          expanded={row.type === "tool" ? state.toolsExpanded : false}
        />
      ),
    })),
  ];

  // Left padding (2 cells) aligns chat content + status bar with the
  // `>` glyph inside the input box (input border at col 0, internal
  // padding 1, so `>` lands at col 2).
  const CONTENT_PAD = 2;
  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(item) => (
          <Box key={item.key} paddingLeft={CONTENT_PAD}>
            {item.node}
          </Box>
        )}
      </Static>
      {liveRows.map((row, i) => (
        <Box key={`live-${i}`} paddingLeft={CONTENT_PAD}>
          <ChatRowView
            row={row}
            expanded={row.type === "tool" ? state.toolsExpanded : false}
          />
        </Box>
      ))}
      {showThinking(state) ? (
        <Box marginBottom={1} paddingLeft={CONTENT_PAD}>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text dimColor> Thinking…</Text>
        </Box>
      ) : null}
      {state.mode === "diff" ? (
        <DiffModal
          changes={state.pending}
          busy={false}
          onApprove={onApprove}
          onClear={onClear}
          onRemoveChange={onRemoveChange}
          onCancel={() => dispatch({ type: "close-diff" })}
        />
      ) : null}
      {state.mode === "buildings-view" ? (
        <BuildingsView
          buildings={state.buildings}
          selectedIndex={state.entityIndex}
          paddingLeft={CONTENT_PAD}
        />
      ) : null}
      {state.mode === "npcs-view" ? (
        <NpcsView
          npcs={state.npcs}
          buildings={state.buildings}
          selectedIndex={state.entityIndex}
          expanded={state.npcExpanded}
          paddingLeft={CONTENT_PAD}
        />
      ) : null}
      {state.statusMessage ? (
        <Box marginBottom={1} paddingLeft={CONTENT_PAD}>
          <Text dimColor>{`› ${state.statusMessage}`}</Text>
        </Box>
      ) : null}
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
      >
        <Text color="cyan">{"> "}</Text>
        {state.inputBuffer === "" && state.mode === "input" ? (
          // Placeholder when nothing typed. Dimmed text overlays the
          // input area; the cursor is rendered first so the visible
          // caret sits at column 0 of the buffer.
          <>
            <Text color="cyan">_</Text>
            <Text dimColor>{` ${INPUT_PLACEHOLDER}`}</Text>
          </>
        ) : (
          <>
            <Text>{state.inputBuffer}</Text>
            <Text color="cyan">{state.mode === "input" ? "_" : ""}</Text>
          </>
        )}
      </Box>
      {state.mode === "input" ? (
        <MentionSuggestions
          buffer={state.inputBuffer}
          buildings={state.buildings}
          npcs={state.npcs}
          selectedIndex={state.mentionSelectedIndex}
          paddingLeft={CONTENT_PAD}
        />
      ) : null}
      {state.mode === "input" ? (
        <SlashSuggestions
          buffer={state.inputBuffer}
          selectedIndex={state.slashSelectedIndex}
          paddingLeft={CONTENT_PAD}
        />
      ) : null}
      <Box paddingLeft={CONTENT_PAD}>
        <StatusBar
          pendingCount={state.pending.length}
          auraCurrent={state.aura.current}
          auraMax={state.aura.max}
          deployStatus={state.deployStatus}
          // Subtract the wrapper's paddingLeft so the inner row fits
          // exactly inside the available area. Otherwise width=cols
          // overflows by CONTENT_PAD cells, wraps, and Ink's height
          // tracking breaks.
          cols={Math.max(20, cols - CONTENT_PAD)}
        />
      </Box>
    </Box>
  );
}

/** Modal-overlay view for `/buildings`. Lists every building in the
 *  town with its id, plotKey, variant, and label. Esc returns to
 *  chat; ↑/↓ navigates (no Enter action — buildings have no detail
 *  panel because everything's already on one line). */
function BuildingsView({
  buildings,
  selectedIndex,
  paddingLeft,
}: {
  buildings: BuildingEntity[];
  selectedIndex: number;
  paddingLeft: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={paddingLeft}>
      <Text bold color={LABEL_COLOR}>
        Buildings ({buildings.length})
      </Text>
      <Text dimColor>↑/↓ navigate · Esc close</Text>
      <Box marginTop={1} flexDirection="column">
        {buildings.length === 0 ? (
          <Text dimColor>No buildings yet.</Text>
        ) : (
          buildings.map((b, i) => {
            const selected = i === selectedIndex;
            const tail = [
              b.label ? `"${b.label}"` : null,
              b.plotKey,
              b.variantId ? `variant: ${b.variantId}` : null,
            ]
              .filter(Boolean)
              .join("  ·  ");
            return (
              <Text key={b.id} bold={selected}>
                {selected ? "▸ " : "  "}
                <Text color="cyan">{b.id}</Text>
                <Text dimColor>{`  ${tail}`}</Text>
              </Text>
            );
          })
        )}
      </Box>
    </Box>
  );
}

/** Modal-overlay view for `/npcs`. Lists every NPC with their name,
 *  building, slot, and description. Enter expands the selected row
 *  into the full system prompt (wrapped, dim) so the user can read it
 *  without leaving the TUI. Esc closes. */
function NpcsView({
  npcs,
  buildings,
  selectedIndex,
  expanded,
  paddingLeft,
}: {
  npcs: NpcEntity[];
  buildings: BuildingEntity[];
  selectedIndex: number;
  expanded: boolean;
  paddingLeft: number;
}): React.ReactElement {
  const buildingLabel = (id: string): string => {
    const b = buildings.find((bb) => bb.id === id);
    return b?.label ?? id;
  };
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={paddingLeft}>
      <Text bold color={LABEL_COLOR}>
        NPCs ({npcs.length})
      </Text>
      <Text dimColor>↑/↓ navigate · Enter toggle prompt · Esc close</Text>
      <Box marginTop={1} flexDirection="column">
        {npcs.length === 0 ? (
          <Text dimColor>No NPCs yet.</Text>
        ) : (
          npcs.map((n, i) => {
            const selected = i === selectedIndex;
            const tail = [
              `in ${buildingLabel(n.buildingId)}`,
              n.slotId ? `slot: ${n.slotId}` : null,
            ]
              .filter(Boolean)
              .join("  ·  ");
            return (
              <Box key={n.id} flexDirection="column">
                <Text bold={selected}>
                  {selected ? "▸ " : "  "}
                  <Text color="cyan">{n.name}</Text>
                  <Text dimColor>{`  ${tail}`}</Text>
                </Text>
                {selected && n.description ? (
                  <Text dimColor>{`    ${n.description}`}</Text>
                ) : null}
                {selected && expanded ? (
                  <Box
                    flexDirection="column"
                    marginTop={1}
                    marginBottom={1}
                    paddingLeft={4}
                  >
                    <Text dimColor>── prompt ──────────────────────</Text>
                    <Text>{n.prompt}</Text>
                    <Text dimColor>────────────────────────────────</Text>
                  </Box>
                ) : null}
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}

/** Inline @-mention autocomplete. Mirrors SlashSuggestions but pulls
 *  from buildings + npcs. Building rows are cyan; NPC rows are warm
 *  orange so they're scannable apart. */
function MentionSuggestions({
  buffer,
  buildings,
  npcs,
  selectedIndex,
  paddingLeft,
}: {
  buffer: string;
  buildings: BuildingEntity[];
  npcs: NpcEntity[];
  selectedIndex: number;
  paddingLeft: number;
}): React.ReactElement | null {
  const prefix = extractMentionPrefix(buffer);
  const list = filterMentions(prefix, buildings, npcs);
  if (list.length === 0) return null;
  const idx = Math.min(selectedIndex, list.length - 1);
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={paddingLeft}>
      <Text dimColor>
        Mentions (↑/↓ navigate · Tab or Enter to insert)
      </Text>
      {list.map((it, i) => {
        const selected = i === idx;
        const tone = it.kind === "npc" ? LABEL_COLOR : "cyan";
        const kindGlyph = it.kind === "npc" ? "npc" : "bld";
        return (
          <Text key={`${it.kind}:${it.id}`} bold={selected}>
            {selected ? "▸ " : "  "}
            <Text dimColor>{`[${kindGlyph}] `}</Text>
            <Text color={tone}>{it.label}</Text>
            <Text dimColor>{`  ${it.sub}`}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

/** Inline suggestion list shown above the input when the buffer starts
 *  with `/`. Mirrors core-cli's CommandList: header row + ↑/↓ navigable
 *  rows + a hint about Tab/Enter. We don't bother with a scroll
 *  window — the registry only has two commands today and any future
 *  growth here is intentional (slash commands are chat-surface
 *  controls, not town actions). */
function SlashSuggestions({
  buffer,
  selectedIndex,
  paddingLeft,
}: {
  buffer: string;
  selectedIndex: number;
  paddingLeft: number;
}): React.ReactElement | null {
  const list = filterSlashCommands(buffer);
  if (list.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={paddingLeft}>
      <Text dimColor>
        Commands (↑/↓ navigate · Tab fills · Enter runs)
      </Text>
      {list.map((cmd, i) => {
        const selected = i === selectedIndex;
        return (
          <Text key={cmd.name} bold={selected}>
            {selected ? "▸ " : "  "}
            <Text color="cyan">{`/${cmd.name}`}</Text>
            <Text dimColor>{` — ${cmd.description}`}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function ChatRowView({
  row,
  expanded,
}: {
  row: ChatRow;
  expanded: boolean;
}): React.ReactElement {
  if (row.type === "user") {
    // Sol-style label header — bold orange "You:" with the user's text
    // on its own row in default white. No bubble bg, no extra spacer
    // line (the marginBottom on the wrapper already breathes for us).
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={LABEL_COLOR}>
          You:
        </Text>
        <Text>{row.text}</Text>
      </Box>
    );
  }
  if (row.type === "assistant") {
    // Same label pattern, "Creator:" for assistant turns.
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={LABEL_COLOR}>
          Creator:
        </Text>
        <Text>{row.text}</Text>
      </Box>
    );
  }
  if (row.type === "tool") {
    return <ToolCallView call={row.call} expanded={expanded} />;
  }
  if (row.type === "error") {
    // Subdued single-line error — red ✗ glyph + default-colored message.
    // No bg fill, no own marginBottom; the next row sets its own gap so
    // errors sit tight against whatever follows.
    return (
      <Box>
        <Text color="red">{"✗ "}</Text>
        <Text>{row.text}</Text>
      </Box>
    );
  }
  // System rows — slash-command output, /help, conversation cleared, etc.
  // Dim white reads as informational; yellow read as a warning.
  return (
    <Box marginBottom={1}>
      <Text dimColor>{row.text}</Text>
    </Box>
  );
}

/** Show the thinking indicator while the SSE stream is open and no
 *  assistant content has landed yet. Once the first text-delta or
 *  tool-input chunk appends a row past the user bubble, hide it. */
function showThinking(state: State): boolean {
  if (state.mode !== "streaming") return false;
  const last = state.rows[state.rows.length - 1];
  return !last || last.type === "user";
}

function helpText(): string {
  return [
    "Slash commands:",
    "  /clear      → drop the current conversation",
    "  /buildings  → list every building in the town",
    "  /npcs       → list every NPC (Enter to read prompt)",
    "  /help       → show this",
    "Inline:",
    "  @ then type → autocomplete NPCs + buildings · Tab/Enter inserts",
    "  / then type → autocomplete slash commands",
    "Bindings:",
    "  Enter   submit",
    "  ↓ (empty input) review pending changes",
    "  Ctrl+O  toggle expand on all tool calls",
    "  Ctrl+C  exit",
  ].join("\n");
}
