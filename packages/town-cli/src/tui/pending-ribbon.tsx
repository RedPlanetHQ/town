// One-line ribbon shown just above the input prompt. When N > 0 it
// inverts so the user notices there's staged work waiting for approval.

import React from "react";
import { Box, Text } from "ink";

interface Props {
  count: number;
}

export function PendingRibbon({ count }: Props): React.ReactElement | null {
  if (count <= 0) {
    return (
      <Box>
        <Text dimColor>No pending changes.</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color="black" backgroundColor="yellow">
        {" ⏳ "}
        {count}
        {" pending change"}
        {count === 1 ? "" : "s"}
        {" — ↓ to review "}
      </Text>
    </Box>
  );
}
