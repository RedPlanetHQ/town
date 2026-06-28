// Pixel-art header — three-building skyline mirroring
// apps/web/public/town_logo.svg.
//
// SVG geometry (32×32 cell grid):
//   • Left building   — cols 4..9, rows 16..26 + window 6..7, 18..19
//   • Center tower    — peak rows 5..6 cols 14..16; stepped pyramid
//                       widens by 2 cells every 2 rows down to cols
//                       11..19 at row 11. Face panel rows 13..17 cols
//                       13..17 with two "eye" cells (14,14) (16,14)
//                       and a chin cell (15,15) inside.
//   • Right building  — cols 21..26, rows 13..26 + window 23..24, 15..16
//
// We render the silhouette + face panel inline. The face is suggested
// with a single inverse-mid row (`█▀▀█`) since terminal cells can't
// cleanly draw the 5×5 face cut-out + 3 inner dots without overhead
// that would dwarf the rest of the chat.

import React from "react";
import { Box, Text } from "ink";

interface Props {
  version: string;
}

const LOGO_COLOR = "rgb(232,224,208)";
const ACCENT_COLOR = "rgb(232,143,106)";

// 7-row silhouette × 13 cols. Sampling the SVG every ~4 rows for the
// vertical compression and using `█`/`▄` for the building bodies.
const LOGO_ROWS = [
  "       ▄▄     ",
  "      ████    ",
  "      █▀▀█    ",
  "      ████    ",
  "  ▄▄▄ ████ ▄▄▄ ",
  "  ███ ████ ███ ",
  "  ███▄████▄███ ",
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
        {/* Spacer rows so the text baseline sits roughly across the
            middle of the silhouette, matching the boot screen layout. */}
        <Text> </Text>
        <Text> </Text>
        <Text bold color={ACCENT_COLOR}>
          town
        </Text>
        <Text dimColor>{`v${version}`}</Text>
        <Text dimColor>Your AI town creator</Text>
      </Box>
    </Box>
  );
}
