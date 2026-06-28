// Minimal text-only header for the chat surface. The pixel-art logo
// (apps/web/public/town_logo.svg) is parked — we'll revisit once the
// duplication / layout bugs in the chat are sorted.

import React from "react";
import { Box, Text } from "ink";

interface Props {
  version: string;
}

const ACCENT = "rgb(232,143,106)";

export function Header({ version }: Props): React.ReactElement {
  // Single-line header — bold accent title + dim tagline. Tighter
  // vertical rhythm than the old three-row stack and reads like CORE
  // CLI's one-line banner.
  return (
    <Box marginBottom={1}>
      <Text bold color={ACCENT}>
        town
      </Text>
      <Text dimColor>{` v${version} · Your AI town creator`}</Text>
    </Box>
  );
}
