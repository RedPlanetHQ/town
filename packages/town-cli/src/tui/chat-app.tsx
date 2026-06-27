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
import { Box, Text, useApp, useInput, useStdout } from "ink";

import { DiffModal, type PendingChange } from "./diff-modal.js";
import { PendingRibbon } from "./pending-ribbon.js";
import { StatusBar } from "./status-bar.js";
import { ToolCallView, type ToolCallState } from "./tool-call.js";
import { streamCreator, type StreamChunk } from "./stream-events.js";

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
  /** Optional kickoff line shown as if the assistant said it. Used by
   *  `town new` to greet the user after scaffolding without burning a
   *  real turn. */
  kickoff?: string;
  /** Apply approved changes locally + redeploy. Returns the new aura
   *  values when the deploy finishes; the chat surface uses them to
   *  refresh the status bar. */
  onApply?: (
    changes: PendingChange[],
  ) => Promise<{ aura?: { current: number; max: number } } | void>;
  /** Drop the server-side pending queue. Called when the user picks
   *  "Clear" in the diff modal. */
  onClearChanges?: () => Promise<void>;
}

export type ChatRow =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; call: ToolCallState }
  | { type: "system"; text: string };

// -----------------------------------------------------------------------------
// Internal state machine
// -----------------------------------------------------------------------------

interface State {
  rows: ChatRow[];
  pending: PendingChange[];
  aura: { current: number; max: number };
  mode: "input" | "streaming" | "diff" | "applying";
  inputBuffer: string;
  /** Active tool-call buffers keyed by toolCallId — referenced both from
   *  the scroll (for rendering) and the chunk handler (for accumulation).
   *  We index here to keep handlers O(1). */
  activeCalls: Map<string, ToolCallState>;
  /** Per-call expansion toggle. Driven by `o` while a tool call is the
   *  most-recent row. */
  expandedCallIds: Set<string>;
  statusMessage?: string;
}

type Action =
  | { type: "set-input"; value: string }
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
  | { type: "toggle-expand-latest" }
  | { type: "reset-conversation" }
  | { type: "set-status"; message?: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "set-input":
      return { ...state, inputBuffer: action.value };
    case "append-row":
      return { ...state, rows: [...state.rows, action.row] };
    case "begin-stream":
      return {
        ...state,
        rows: [...state.rows, { type: "user", text: action.userText }],
        mode: "streaming",
        inputBuffer: "",
        statusMessage: undefined,
      };
    case "end-stream":
      return {
        ...state,
        mode: "input",
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
    case "toggle-expand-latest": {
      const last = [...state.rows].reverse().find((r) => r.type === "tool");
      if (!last || last.type !== "tool") return state;
      const id = last.call.toolCallId;
      const next = new Set(state.expandedCallIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...state, expandedCallIds: next };
    }
    case "reset-conversation":
      return {
        ...state,
        rows: [],
        pending: [],
        mode: "input",
        statusMessage: "Conversation cleared.",
        activeCalls: new Map(),
        expandedCallIds: new Set(),
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
        rows: [
          ...state.rows,
          { type: "system", text: `error: ${chunk.errorText}` },
        ],
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

  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    rows: props.initialMessages ?? [],
    pending: props.initialPendingChanges ?? [],
    aura: props.initialAura ?? { current: 1000, max: 1000 },
    mode: "input" as const,
    inputBuffer: "",
    activeCalls: new Map(),
    expandedCallIds: new Set<string>(),
    statusMessage: undefined,
  }));

  // Stash latest pending changes from any tool-output that brings them.
  // The mutation tools don't echo the queue, so we re-query through the
  // turn boundary via the chunk count instead — see endStreamRefresh.
  const [pendingPollNonce, setPendingPollNonce] = useState(0);

  useEffect(() => {
    if (!props.kickoff) return;
    dispatch({ type: "append-row", row: { type: "assistant", text: props.kickoff } });
  }, [props.kickoff]);

  // After each turn finishes, ask the server for the up-to-date queue +
  // aura. Tool outputs surface aura inline, but the queue itself needs a
  // round-trip — the model stages, we render the call, then refresh.
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
        };
        if (cancelled) return;
        if (body.pendingChanges) {
          dispatch({ type: "set-pending", pending: body.pendingChanges });
        }
        if (body.aura) {
          dispatch({ type: "set-aura", aura: body.aura });
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

      if (trimmed === "/clear") {
        dispatch({ type: "set-input", value: "" });
        try {
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
        } catch {
          // server unreachable — still reset locally so the user can
          // keep working offline-ish.
        }
        dispatch({ type: "reset-conversation" });
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
            type: "system",
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
    dispatch({ type: "enter-applying", message: "Applying changes…" });
    try {
      const result = await props.onApply(state.pending);
      if (result && result.aura) {
        dispatch({ type: "set-aura", aura: result.aura });
      }
      dispatch({
        type: "exit-applying",
        message: "Applied. Town redeployed.",
      });
    } catch (err) {
      dispatch({
        type: "exit-applying",
        message: `Apply failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, [props, state.pending]);

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

      if (state.mode === "streaming") {
        // Streaming is non-interruptible for now; flag tooling backlog.
        return;
      }

      // Mode is 'input' from here on.
      if (key.return) {
        const text = state.inputBuffer;
        if (!text.trim()) return;
        void submitMessage(text);
        return;
      }
      if (key.downArrow && state.inputBuffer === "") {
        dispatch({ type: "open-diff" });
        return;
      }
      if (input === "o" && key.ctrl === false && state.inputBuffer === "") {
        // Toggle the latest tool-call row expansion. We only honour the
        // shortcut when the input is empty so a literal "o" in a message
        // doesn't lose itself.
        dispatch({ type: "toggle-expand-latest" });
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

  const cols = stdout?.columns ?? 80;
  return (
    <Box flexDirection="column" width={cols}>
      <Box flexDirection="column" marginBottom={1}>
        {state.rows.map((row, i) => (
          <ChatRowView
            key={i}
            row={row}
            expanded={
              row.type === "tool"
                ? state.expandedCallIds.has(row.call.toolCallId)
                : false
            }
          />
        ))}
        {state.mode === "streaming" ? (
          <Text dimColor>…streaming</Text>
        ) : null}
      </Box>
      {state.mode === "diff" ? (
        <DiffModal
          changes={state.pending}
          busy={false}
          onApprove={onApprove}
          onClear={onClear}
          onCancel={() => dispatch({ type: "close-diff" })}
        />
      ) : (
        <PendingRibbon count={state.pending.length} />
      )}
      <Box>
        <Text color="cyan">{"> "}</Text>
        <Text>{state.inputBuffer}</Text>
        <Text color="cyan">{state.mode === "input" ? "▎" : ""}</Text>
      </Box>
      {state.statusMessage ? (
        <Box>
          <Text dimColor>{state.statusMessage}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <StatusBar
          cwd={props.cwd}
          townSlug={props.townSlug}
          auraCurrent={state.aura.current}
          auraMax={state.aura.max}
        />
      </Box>
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
    return (
      <Box>
        <Text color="cyan">user: </Text>
        <Text>{row.text}</Text>
      </Box>
    );
  }
  if (row.type === "assistant") {
    return (
      <Box>
        <Text color="green">assistant: </Text>
        <Text>{row.text}</Text>
      </Box>
    );
  }
  if (row.type === "tool") {
    return <ToolCallView call={row.call} expanded={expanded} />;
  }
  return (
    <Box>
      <Text color="yellow">{row.text}</Text>
    </Box>
  );
}

function helpText(): string {
  return [
    "Slash commands:",
    "  /clear  → drop the current conversation",
    "  /help   → show this",
    "Bindings:",
    "  Enter   submit",
    "  ↓ (empty input) review pending changes",
    "  o (empty input) toggle expand on the latest tool call",
    "  Ctrl+C  exit",
  ].join("\n");
}
