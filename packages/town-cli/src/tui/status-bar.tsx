// Bottom-line status strip: cwd · town slug · live aura.
//
// Renders inline because Ink's <Static> doesn't redraw, and aura is
// expected to tick down as the chat stages mutations. Aura colour
// tiers: cyan when > 30 %, yellow 10–30 %, red < 10 %.

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
  const ratio = auraMax > 0 ? auraCurrent / auraMax : 1;
  const auraColor: "cyan" | "yellow" | "red" =
    ratio < 0.1 ? "red" : ratio < 0.3 ? "yellow" : "cyan";
  return (
    <Box>
      <Text dimColor>{tildeify(cwd)}</Text>
      <Text dimColor> · </Text>
      <Text dimColor>{townSlug}</Text>
      <Text dimColor> · </Text>
      <Text color={auraColor}>
        {"⚡ "}
        {auraCurrent}/{auraMax}
      </Text>
    </Box>
  );
}
