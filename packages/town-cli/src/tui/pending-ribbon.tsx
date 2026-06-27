// One-line ribbon shown just above the input prompt. Only renders when
// there are staged changes — at zero we render nothing so the chrome
// stays out of the way.

import React from "react";
import { Box, Text } from "ink";

interface Props {
  count: number;
}

export function PendingRibbon({ count }: Props): React.ReactElement | null {
  if (count <= 0) return null;
  return (
    <Box>
      <Text dimColor>
        {count} pending change{count === 1 ? "" : "s"} · ↓ to review
      </Text>
    </Box>
  );
}
