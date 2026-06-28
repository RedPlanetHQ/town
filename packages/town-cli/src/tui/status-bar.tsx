// Bottom status row — pending state on the left, aura with a small
// progress bar on the right.
//
// ASCII-only on purpose: wide-character glyphs (⚡, ↓, em-dash) trip
// Ink's width math in some terminals and cause the dynamic frame to
// drift. Boring text is reliable.
//
// Layout: explicit `width` on the outer Box + `justifyContent` to
// flush the right segment to the right edge. The flexGrow=1 spacer
// pattern only works when the parent has a fixed width — otherwise
// the parent shrinks to content and the spacer is zero cells wide.

import React from "react";
import { Box, Text } from "ink";

interface Props {
  pendingCount: number;
  auraCurrent: number;
  auraMax: number;
  cols: number;
  /** Inline status line shown in place of the "pending" / "no pending"
   *  segment while a background deploy is in flight. Examples:
   *  "deploying…", "deployed", "deploy failed: <msg>". `null` means
   *  fall back to the normal pending indicator. */
  deployStatus?: string | null;
}

const LABEL_COLOR = "rgb(232,143,106)"; // warm orange — matches chat labels
const BAR_WIDTH = 10;

function buildBar(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * BAR_WIDTH);
  return "#".repeat(filled) + "-".repeat(BAR_WIDTH - filled);
}

export function StatusBar({
  pendingCount,
  auraCurrent,
  auraMax,
  cols,
  deployStatus,
}: Props): React.ReactElement {
  const ratio = auraMax > 0 ? auraCurrent / auraMax : 1;
  const auraColor: "cyan" | "yellow" | "red" =
    ratio < 0.1 ? "red" : ratio < 0.3 ? "yellow" : "cyan";
  const bar = buildBar(ratio);

  // Pick the left segment. Deploy status wins over pending count so
  // the user sees the in-flight phase right where they expect; once
  // the deploy clears, the row settles back into pending/no-pending.
  const left = (() => {
    if (deployStatus) {
      const tone =
        deployStatus.startsWith("deploy failed") ? "red" : LABEL_COLOR;
      return (
        <>
          <Text bold color={tone}>
            ▸
          </Text>
          <Text dimColor>{` ${deployStatus}`}</Text>
        </>
      );
    }
    if (pendingCount > 0) {
      return (
        <>
          <Text bold color={LABEL_COLOR}>
            {pendingCount}
          </Text>
          <Text dimColor>{" pending (press down to review)"}</Text>
        </>
      );
    }
    return <Text dimColor>no pending changes</Text>;
  })();

  return (
    <Box width={cols} justifyContent="space-between">
      <Box flexShrink={0}>{left}</Box>
      <Box flexShrink={0}>
        <Text dimColor>aura </Text>
        <Text color={auraColor}>
          [{bar}] {auraCurrent}/{auraMax}
        </Text>
      </Box>
    </Box>
  );
}
