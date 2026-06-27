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
  return (
    <Box width={cols} justifyContent="space-between">
      <Box>
        {pendingCount > 0 ? (
          <>
            <Text bold color={LABEL_COLOR}>
              Changes:
            </Text>
            <Text>
              {" "}
              {pendingCount} staged
            </Text>
          </>
        ) : (
          <Text> </Text>
        )}
      </Box>
      <Box>
        <Text color="cyan">⚡</Text>
        <Text> </Text>
        <Text color={auraColor}>
          {auraCurrent}/{auraMax}
        </Text>
      </Box>
    </Box>
  );
}
