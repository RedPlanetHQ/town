// Pending-changes overlay. Lists the queued CreatorChange rows, lets
// the user clear them (drop the queue server-side) or approve them
// (apply locally + deploy). Lives in a separate component so the chat
// loop's input handling stays focused on text entry.

import React from "react";
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
}

export function DiffModal({
  changes,
  busy,
  message,
  onClear,
  onApprove,
  onCancel,
}: Props): React.ReactElement {
  useInput((input, key) => {
    if (busy) return;
    if (key.escape) return onCancel();
    if (input === "c") return onClear();
    if (input === "a") return onApprove();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold>
        {changes.length === 0
          ? "No pending changes"
          : `${changes.length} pending change${changes.length === 1 ? "" : "s"}`}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {changes.length === 0 ? (
          <Text dimColor>Nothing staged. Press Esc to return.</Text>
        ) : (
          changes.map((c) => (
            <Box key={c.id}>
              <Text color="cyan">[{c.kind}]</Text>
              <Text> {c.summary}</Text>
            </Box>
          ))
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {busy ? (
          <Text color="yellow">{message ?? "Working…"}</Text>
        ) : message ? (
          <Text color="gray">{message}</Text>
        ) : null}
        <Text dimColor>
          [a] Approve · [c] Clear · [Esc] Back
        </Text>
      </Box>
    </Box>
  );
}
