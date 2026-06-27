// Bottom-line status strip: cwd · town slug · live aura.
//
// Renders inline because Ink's <Static> doesn't redraw, and aura is
// expected to tick down as the chat stages mutations. The current /max
// pair is rendered with a lightning bolt so it reads as a budget at a
// glance.

import React from "react";
import { Box, Text } from "ink";

import { tildeify } from "./paths.js";

interface Props {
  cwd: string;
  townSlug: string;
  auraCurrent: number;
  auraMax: number;
}

export function StatusBar({
  cwd,
  townSlug,
  auraCurrent,
  auraMax,
}: Props): React.ReactElement {
  const low = auraMax > 0 && auraCurrent / auraMax < 0.2;
  return (
    <Box>
      <Text color="gray">{tildeify(cwd)}</Text>
      <Text color="gray"> · </Text>
      <Text color="cyan">{townSlug}</Text>
      <Text color="gray"> · </Text>
      <Text color={low ? "red" : "yellow"}>
        {"⚡ "}
        {auraCurrent}/{auraMax}
      </Text>
    </Box>
  );
}
