// Bottom status row — pending changes left, aura right.
//
// Sits below the input box (under the divider) and replaces the older
// `~/cwd · slug · aura` row. The terminal already shows the cwd above
// the Ink mount, so we keep this row focused on the two pieces of state
// the user actually cares about while staging changes.
//
// Aura colour tiers (unchanged from the original status bar):
//   cyan when ≥ 30 %, yellow 10–30 %, red < 10 %.

import React from "react";
import { Box, Text } from "ink";

interface Props {
  pendingCount: number;
  auraCurrent: number;
  auraMax: number;
  cols: number;
}

const LABEL_COLOR = "rgb(232,143,106)"; // warm orange — matches chat labels

export function StatusBar({
  pendingCount,
  auraCurrent,
  auraMax,
  cols,
}: Props): React.ReactElement {
  const ratio = auraMax > 0 ? auraCurrent / auraMax : 1;
  const auraColor: "cyan" | "yellow" | "red" =
    ratio < 0.1 ? "red" : ratio < 0.3 ? "yellow" : "cyan";

  // Compose a single status string so the line never wraps mid-token
  // when Ink's flex layout under-reports the terminal width. Left and
  // right segments share one Text element, padded with spaces so the
  // aura sits flush to the right edge. CORE-style lowercase phrasing:
  // `{N} pending` — number bold orange, "pending" dim. Empty when zero.
  const leftCount = pendingCount > 0 ? String(pendingCount) : "";
  const leftSuffix = pendingCount > 0 ? " pending" : "";
  const right = `⚡ ${auraCurrent}/${auraMax}`;
  const used = leftCount.length + leftSuffix.length + right.length;
  const fill = Math.max(1, cols - used);
  return (
    <Box>
      <Text bold color={LABEL_COLOR}>
        {leftCount}
      </Text>
      <Text dimColor>{leftSuffix}</Text>
      <Text>{" ".repeat(fill)}</Text>
      <Text color={auraColor}>{right}</Text>
    </Box>
  );
}
