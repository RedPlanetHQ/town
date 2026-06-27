// Stacked header for the chat surface — three-building pixel-art
// silhouette next to the name + version + tagline. Mirrors the boot
// screen at apps/web/public/town_logo.svg.
//
// SVG source (32×32 cell grid, viewBox 0..512 with 16px cells):
//   • Short left building   — cols 4..9, rows 16..26 + window 6..7, 18..19.
//   • Center stepped tower  — peak rows 5..6 cols 14..16; widens by 2
//     cols every two rows until cols 11..19; face at rows 13..17 with
//     2 eye dots (row 14, cols 14 and 16) + a center dot (row 15, col 15).
//   • Medium right building — cols 21..26, rows 13..26 + window 23..24,
//     15..16.
//
// We compress that 32-cell silhouette into a 7-row terminal logo. Each
// terminal row collapses ~3 source rows, and the face dots are rendered
// as a single `▀▀` pair that reads as eyes from any reasonable distance.

import React from "react";
import { Box, Text } from "ink";

interface Props {
  version: string;
}

const LOGO_COLOR = "rgb(232,224,208)";
const LOGO_ROWS = [
  "     ▄▄       ",
  "    ████      ",
  "    █▀▀█      ",
  " ▄  ████  ▄▄  ",
  " █  ████  ██  ",
  " █  █▀▀█  ██  ",
  " ██████████▄▄ ",
];

export function Header({ version }: Props): React.ReactElement {
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexDirection="column" marginRight={2} flexShrink={0}>
        {LOGO_ROWS.map((row, i) => (
          <Text key={i} color={LOGO_COLOR}>
            {row}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        {/* Spacer rows so the text baseline sits in the lower half of the
            5-row logo, matching the boot screen proportions. */}
        <Text> </Text>
        <Text> </Text>
        <Text bold color={LOGO_COLOR}>
          town
        </Text>
        <Text dimColor>v{version}</Text>
        <Text dimColor>Your AI town creator</Text>
      </Box>
    </Box>
  );
}
