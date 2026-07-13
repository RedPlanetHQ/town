export type StampShape = "circle" | "rect";

export type PassportKind = "authed" | "guest";

export interface PassportStamp {
  townSlug: string;
  townName: string;
  visitedAt: Date;
  color?: string;
  glyph?: string;
  shape?: StampShape;
}

export interface PassportData {
  kind: PassportKind;
  handle: string;
  displayName: string;
  passportId: string;
  issuedAt: Date;
  townsOwned: number;
  stamps: PassportStamp[];
}

export interface RenderedStamp {
  townSlug: string;
  townName: string;
  visitedAt: Date;
  color: string;
  glyph: string;
  shape: StampShape;
}
