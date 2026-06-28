// Pending-changes overlay. Lists the queued tool-call rows, lets the
// user remove one (x / Delete), clear all (c), or approve the queue
// (a — applies locally + deploys). ↑/↓ navigate.

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

export interface PendingChange {
  id: string;
  kind: string;
  summary: string;
}

interface Props {
  changes: PendingChange[];
  busy: boolean;
  message?: string;
  onClear: () => void;
  onApprove: () => void;
  onCancel: () => void;
  /** Drop a single pending entry by id. The modal keeps the rest of
   *  the queue visible. */
  onRemoveChange?: (id: string) => Promise<void> | void;
}

const ACCENT = "rgb(232,143,106)";

export function DiffModal({
  changes,
  busy,
  message,
  onClear,
  onApprove,
  onCancel,
  onRemoveChange,
}: Props): React.ReactElement {
  const [cursor, setCursor] = useState(0);

  // Clamp cursor when the list shrinks (e.g. after a delete).
  useEffect(() => {
    if (cursor > Math.max(0, changes.length - 1)) {
      setCursor(Math.max(0, changes.length - 1));
    }
  }, [changes.length, cursor]);

  useInput((input, key) => {
    if (busy) return;
    if (key.escape) return onCancel();
    if (input === "c") return onClear();
    if (input === "a") return onApprove();
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(Math.max(0, changes.length - 1), c + 1));
      return;
    }
    if (
      (input === "x" || key.delete || key.backspace) &&
      onRemoveChange &&
      changes[cursor]
    ) {
      void onRemoveChange(changes[cursor]!.id);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={ACCENT}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={ACCENT}>
        {changes.length === 0
          ? "No pending changes"
          : `${changes.length} pending change${changes.length === 1 ? "" : "s"}`}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {changes.length === 0 ? (
          <Text dimColor>Nothing staged. Press Esc to return.</Text>
        ) : (
          changes.map((c, i) => {
            const selected = i === cursor;
            return (
              <Box key={c.id}>
                <Text color={selected ? ACCENT : "gray"}>
                  {selected ? "› " : "  "}
                </Text>
                <Text color="cyan">[{c.kind}]</Text>
                <Text bold={selected}> {c.summary}</Text>
              </Box>
            );
          })
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {busy ? (
          <Text color="yellow">{message ?? "Working…"}</Text>
        ) : message ? (
          <Text color="gray">{message}</Text>
        ) : null}
        <Text dimColor>
          ↑/↓ select · [x] remove · [a] approve · [c] clear · [Esc] back
        </Text>
      </Box>
    </Box>
  );
}
