// One row per tool call in the chat scroll.
//
// Collapsed (default): `{dot} {bold(name)} {dim('(' + argSummary + ')')}`
// where the dot reflects the run state — ◌ yellow while running, ● green
// when the output lands, ✗ red on error.
//
// Expanded (transcript-wide toggle via Ctrl+O): the header line plus a
// 2-space-indented JSON dump of input and output, with the output capped
// to the first 3 lines + a "+N more lines" hint when larger. The toggle
// is owned by ChatApp so collapse state survives further stream chunks
// and so flipping it once affects every tool call in the scroll.

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
  const argsSummary = summarizeArgs(call.input);
  const dot = call.error ? (
    <Text color="red">{"✗"}</Text>
  ) : call.done ? (
    <Text color="green">{"●"}</Text>
  ) : (
    <Text color="yellow">{"◌"}</Text>
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {dot}
        <Text> </Text>
        <Text bold>{call.toolName}</Text>
        <Text dimColor>{` (${argsSummary})`}</Text>
      </Box>
      {expanded ? (
        <Box flexDirection="column" marginLeft={2}>
          {call.input !== undefined ? (
            <Text dimColor>input: {safeStringify(call.input)}</Text>
          ) : call.partialInput ? (
            <Text dimColor>input (streaming): {call.partialInput}</Text>
          ) : null}
          {call.output !== undefined ? (
            <Text dimColor>output: {previewJson(call.output)}</Text>
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
  // Pick the most useful key for the common mutation tools. We render
  // it as `key="value"` so it reads like the brief's example
  // (plotKey="library", name="Judge Bork", …).
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
      return `${k}=${JSON.stringify(obj[k])}`;
    }
  }
  const first = keys[0]!;
  const v = obj[first];
  return typeof v === "object"
    ? `${first}={…}`
    : `${first}=${JSON.stringify(v)}`;
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

/** Render JSON capped to the first 3 lines with a "+N more lines" hint
 *  when the dump is larger. Used by the expanded output preview to keep
 *  large tool results from drowning the scroll. */
function previewJson(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v, null, 2);
  } catch {
    s = String(v);
  }
  const lines = s.split("\n");
  if (lines.length <= 3) return s;
  const head = lines.slice(0, 3).join("\n");
  const more = lines.length - 3;
  return `${head}\n+${more} more line${more === 1 ? "" : "s"}`;
}
