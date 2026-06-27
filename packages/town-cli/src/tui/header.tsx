// Sol-style stacked header for the chat surface.
//
// Layout:
//   {logo block, 5 rows × 6 cols}   town          (bold white)
//                                   v0.2.0        (dim)
//                                   Your AI town  (dim)
//                                   creator
//
// The logo is rendered with `█` glyphs in a warm terracotta (#c46f5a)
// to mirror the CORE CLI's "Sol" header. Five rows tall so the three
// stacked text rows can sit alongside without overflow.

import React from "react";
import { Box, Text } from "ink";

interface Props {
  version: string;
}

const LOGO_COLOR = "rgb(196,111,90)";
// Five rows × six cols of solid block. Keeps the silhouette readable
// even at 30-col terminals and lines up vertically with the three text
// rows beside it.
const LOGO_ROWS = [
  "██████",
  "██████",
  "██████",
  "██████",
  "██████",
];

export function Header({ version }: Props): React.ReactElement {
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexDirection="column" marginRight={2}>
        {LOGO_ROWS.map((row, i) => (
          <Text key={i} color={LOGO_COLOR}>
            {row}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text bold color="white">
          town
        </Text>
        <Text dimColor>v{version}</Text>
        <Text dimColor>Your AI town creator</Text>
      </Box>
    </Box>
  );
}
