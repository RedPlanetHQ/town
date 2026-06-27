// One row per tool call in the chat scroll. Shows a short summary by
// default; toggles to a full args + result dump when `expanded` is true.
// Expansion is driven by the parent (chat-app keeps a per-call boolean
// keyed by toolCallId) so collapse state survives further stream
// chunks.

import React from "react";
import { Box, Text } from "ink";

export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  /** Accumulated partial args while the model is streaming the tool
   *  input. Replaced by `input` once `tool-input-available` lands. */
  partialInput?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  done: boolean;
}

interface Props {
  call: ToolCallState;
  expanded: boolean;
}

export function ToolCallView({ call, expanded }: Props): React.ReactElement {
  const status = call.error
    ? "error"
    : call.done
      ? "done"
      : call.input !== undefined
        ? "running"
        : "input…";
  const color = call.error ? "red" : call.done ? "green" : "yellow";
  const argsSummary = summarizeArgs(call.input);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>{`[tool ${call.toolName}]`}</Text>
        <Text dimColor>{` (${status})`}</Text>
        {argsSummary ? <Text> {argsSummary}</Text> : null}
      </Box>
      {expanded ? (
        <Box flexDirection="column" marginLeft={2}>
          {call.input !== undefined ? (
            <Text dimColor>input: {safeStringify(call.input)}</Text>
          ) : call.partialInput ? (
            <Text dimColor>input (streaming): {call.partialInput}</Text>
          ) : null}
          {call.output !== undefined ? (
            <Text dimColor>output: {safeStringify(call.output)}</Text>
          ) : null}
          {call.error ? <Text color="red">error: {call.error}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}

function summarizeArgs(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "object") return String(input);
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "";
  // Pick the most useful key for the common mutation tools.
  const order = [
    "plotKey",
    "buildingId",
    "name",
    "label",
    "npcId",
    "key",
    "category",
  ];
  for (const k of order) {
    if (k in obj && typeof obj[k] !== "object") {
      return `${k}=${String(obj[k])}`;
    }
  }
  const first = keys[0]!;
  const v = obj[first];
  return typeof v === "object"
    ? `${first}={…}`
    : `${first}=${String(v)}`;
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v, null, 2);
    if (s.length > 400) return s.slice(0, 400) + "…";
    return s;
  } catch {
    return String(v);
  }
}
