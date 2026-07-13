import type { PassportKind } from "./types";

export interface PassportTheme {
  page: string;      // page background
  ink: string;       // main text + line color
  brand: string;     // header + accent color
  spineOpacity: number;
}

export const PASSPORT_THEMES: Record<PassportKind, PassportTheme> = {
  authed: {
    page: "#f7ecd3",
    ink: "#3a2a15",
    brand: "#3a2a15",
    spineOpacity: 0.45,
  },
  guest: {
    // Cool bluish-parchment + dusty teal ink — visually reads as "temporary,
    // not-yet-official" without shouting DRAFT at the user.
    page: "#e3ebee",
    ink: "#1f4b58",
    brand: "#1f4b58",
    spineOpacity: 0.35,
  },
};
