import type { PassportData, PassportStamp, RenderedStamp } from "./types";
import { paletteForSlug, tiltFor } from "./palette";
import { PASSPORT_THEMES, type PassportTheme } from "./theme";

export const SPREAD_WIDTH = 900;
export const SPREAD_HEIGHT = 560;
// Each page holds 5 stamps. Spread 1 has identity on the left + 5
// stamps on the right; every following spread has 5 left + 5 right.
export const STAMPS_PER_PAGE = 5;
export const STAMPS_ON_FIRST_SPREAD = STAMPS_PER_PAGE;
export const STAMPS_PER_FULL_SPREAD = STAMPS_PER_PAGE * 2;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function resolveStamp(stamp: PassportStamp): RenderedStamp {
  const derived = paletteForSlug(stamp.townSlug);
  return {
    townSlug: stamp.townSlug,
    townName: stamp.townName,
    visitedAt: stamp.visitedAt,
    color: stamp.color ?? derived.color,
    glyph: stamp.glyph ?? derived.glyph,
    shape: stamp.shape ?? derived.shape,
  };
}

function fmtStampDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}·${MONTHS[d.getUTCMonth()]}·${String(d.getUTCFullYear()).slice(-2)}`;
}

function fmtLongDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")} · ${MONTHS[d.getUTCMonth()]} · ${d.getUTCFullYear()}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function initialsFrom(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

function mrzName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z]+/g, " ")
    .trim()
    .split(/\s+/)
    .join("&lt;&lt;");
}

function renderDefs(theme: PassportTheme): string {
  const spineDim = (theme.spineOpacity * 0.4).toFixed(3);
  return `<defs>
    <linearGradient id="spine" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0%" stop-color="#000" stop-opacity="${spineDim}"/>
      <stop offset="50%" stop-color="#000" stop-opacity="${theme.spineOpacity}"/>
      <stop offset="100%" stop-color="#000" stop-opacity="${spineDim}"/>
    </linearGradient>
  </defs>`;
}

function renderSpreadBackground(theme: PassportTheme): string {
  return `<rect x="20" y="20" width="860" height="520" fill="${theme.page}" rx="6"/>
    <rect x="440" y="20" width="20" height="520" fill="url(#spine)"/>`;
}

export function renderIdentityPage(data: PassportData): string {
  const name = esc(data.displayName.toUpperCase());
  const num = esc(data.passportId);
  const issued = esc(fmtLongDate(data.issuedAt));
  const townsOwned = `${data.townsOwned} TOWN${data.townsOwned === 1 ? "" : "S"}`;
  const initials = esc(initialsFrom(data.displayName));
  const mrz1 = `P&lt;TOWN${mrzName(data.displayName)}${"&lt;".repeat(Math.max(0, 30 - mrzName(data.displayName).length / 4))}`;
  const yr = data.issuedAt.getUTCFullYear() % 100;
  const mm = String(data.issuedAt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(data.issuedAt.getUTCDate()).padStart(2, "0");
  // MRZ line 2 wants a 9-char alphanumeric passport number field.
  // Strip separators and pad with `0` to keep the column width stable
  // regardless of whether the id is numeric (old backfill) or base36.
  const mrzNum = num.replace(/-/g, "").padEnd(9, "0").slice(0, 9);
  const mrz2 = `${mrzNum}&lt;6TOWN${yr}${mm}${dd}&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;20`;

  return `<g transform="translate(60, 60)" fill="__INK__" font-family="'Courier New', Menlo, monospace">
    <circle cx="180" cy="30" r="18" fill="none" stroke="__INK__" stroke-width="2"/>
    <text x="180" y="36" text-anchor="middle" font-size="16" font-weight="bold">T</text>
    <text x="180" y="80" text-anchor="middle" font-size="14" letter-spacing="4" font-weight="bold">TOWN PASSPORT</text>
    <line x1="40" y1="95" x2="320" y2="95" stroke="__INK__" stroke-width="1" opacity="0.4"/>
    <rect x="20" y="115" width="130" height="150" fill="none" stroke="__INK__" stroke-width="2" stroke-dasharray="4 4" opacity="0.5"/>
    <text x="85" y="200" text-anchor="middle" font-size="32" font-weight="bold" opacity="0.35">${initials}</text>
    <g font-size="9">
      <text x="175" y="130" opacity="0.6" letter-spacing="1">NAME / NOM</text>
      <text x="175" y="148" font-size="14" font-weight="bold">${name}</text>
      <text x="175" y="180" opacity="0.6" letter-spacing="1">PASSPORT NO / N°</text>
      <text x="175" y="197" font-size="13" font-weight="bold" letter-spacing="1">${num}</text>
      <text x="175" y="225" opacity="0.6" letter-spacing="1">ISSUED / DÉLIVRÉ</text>
      <text x="175" y="242" font-size="12">${issued}</text>
      <text x="175" y="270" opacity="0.6" letter-spacing="1">TOWNS OWNED</text>
      <text x="175" y="287" font-size="13" font-weight="bold">${townsOwned}</text>
    </g>
    <line x1="20" y1="325" x2="360" y2="325" stroke="__INK__" stroke-width="1" opacity="0.4"/>
    <text x="20" y="340" font-size="8" opacity="0.6" letter-spacing="1">SIGNATURE / SIGNATURE</text>
    <text x="360" y="340" font-size="8" opacity="0.6" text-anchor="end" letter-spacing="1">PAGE 1</text>
    <g font-size="9" letter-spacing="2" opacity="0.85">
      <text x="20" y="380">${mrz1}</text>
      <text x="20" y="395">${mrz2}</text>
    </g>
  </g>`;
}

function renderStamp(stamp: RenderedStamp, cx: number, cy: number, rotation: number): string {
  const name = esc(stamp.townName.toUpperCase());
  const date = esc(fmtStampDate(stamp.visitedAt));
  const glyph = esc(stamp.glyph);
  const color = stamp.color;
  const nameSize = name.length > 9 ? 9 : 10;

  if (stamp.shape === "rect") {
    return `<g transform="translate(${cx}, ${cy}) rotate(${rotation})">
      <rect x="-48" y="-32" width="96" height="64" fill="none" stroke="${color}" stroke-width="3" opacity="0.85"/>
      <rect x="-44" y="-28" width="88" height="56" fill="none" stroke="${color}" stroke-width="1" opacity="0.6"/>
      <text x="0" y="-10" text-anchor="middle" font-size="11" fill="${color}" font-weight="bold" letter-spacing="2">${name}</text>
      <text x="0" y="6" text-anchor="middle" font-size="12" fill="${color}">${glyph}</text>
      <text x="0" y="22" text-anchor="middle" font-size="7" fill="${color}" letter-spacing="1">${date}</text>
    </g>`;
  }
  return `<g transform="translate(${cx}, ${cy}) rotate(${rotation})">
    <circle cx="0" cy="0" r="45" fill="none" stroke="${color}" stroke-width="3" opacity="0.85"/>
    <circle cx="0" cy="0" r="40" fill="none" stroke="${color}" stroke-width="1" opacity="0.6"/>
    <text x="0" y="-12" text-anchor="middle" font-size="${nameSize}" fill="${color}" font-weight="bold" letter-spacing="1">${name}</text>
    <text x="0" y="6" text-anchor="middle" font-size="14" fill="${color}">${glyph}</text>
    <text x="0" y="24" text-anchor="middle" font-size="7" fill="${color}" letter-spacing="1">${date}</text>
  </g>`;
}

// 5 slots per page — 3 across the top row, 2 centered on the bottom
// row. Index 5 is the "next stamp" placeholder slot for the final
// (partially filled) page.
const PAGE_STAMP_POSITIONS: Array<[number, number]> = [
  [ 80, 110], [200, 115], [320, 108],
  [140, 240], [270, 235],
  [200, 348], // placeholder position when the last page has <5 stamps
];

interface StampsPageOpts {
  stamps: RenderedStamp[];
  originX: number;
  originY: number;
  pageNumber: number;
  isRight: boolean;
  isLastPage: boolean;
  totalStamps: number;
}

function renderStampsPage(opts: StampsPageOpts): string {
  const { stamps, originX, originY, pageNumber, isRight, isLastPage, totalStamps } = opts;

  const header = `<text x="${originX + 180}" y="${originY + 30}" text-anchor="middle" fill="__INK__" font-family="'Courier New', Menlo, monospace" font-size="14" letter-spacing="4" font-weight="bold">TOWNS VISITED</text>
    <line x1="${originX + 40}" y1="${originY + 42}" x2="${originX + 320}" y2="${originY + 42}" stroke="__INK__" stroke-width="1" opacity="0.4"/>`;

  const stampSvg = stamps.map((s, i) => {
    const [dx, dy] = PAGE_STAMP_POSITIONS[i]!;
    return renderStamp(s, originX + dx, originY + dy, tiltFor(s.townSlug, i));
  }).join("\n");

  let placeholder = "";
  if (isLastPage && stamps.length < STAMPS_PER_PAGE) {
    const [dx, dy] = PAGE_STAMP_POSITIONS[stamps.length]!;
    placeholder = `<g transform="translate(${originX + dx}, ${originY + dy})" opacity="0.2">
      <circle cx="0" cy="0" r="42" fill="none" stroke="__INK__" stroke-width="2" stroke-dasharray="6 6"/>
      <text x="0" y="4" text-anchor="middle" font-family="'Courier New', Menlo, monospace" font-size="8" fill="__INK__" letter-spacing="1">NEXT STAMP</text>
    </g>`;
  }

  const footer = isLastPage
    ? `<text x="${originX + 180}" y="${originY + 380}" text-anchor="middle" font-family="'Courier New', Menlo, monospace" font-size="8" fill="__INK__" opacity="0.55" letter-spacing="2">— ${totalStamps} STAMP${totalStamps === 1 ? "" : "S"}${totalStamps === 0 ? " · GO VISIT A TOWN " : ""} —</text>`
    : "";

  const pageLabel = `<text x="${isRight ? originX + 360 : originX + 20}" y="${originY + 415}" font-family="'Courier New', Menlo, monospace" font-size="8" fill="__INK__" opacity="0.6" text-anchor="${isRight ? "end" : "start"}" letter-spacing="1">PAGE ${pageNumber}</text>`;

  return `${header}${stampSvg}${placeholder}${footer}${pageLabel}`;
}

export function spreadCountFor(stampCount: number): number {
  if (stampCount <= STAMPS_ON_FIRST_SPREAD) return 1;
  const remainder = stampCount - STAMPS_ON_FIRST_SPREAD;
  return 1 + Math.ceil(remainder / STAMPS_PER_FULL_SPREAD);
}

function stampsForSpread(all: RenderedStamp[], spreadIndex: number): { left: RenderedStamp[]; right: RenderedStamp[] } {
  if (spreadIndex === 0) {
    return { left: [], right: all.slice(0, STAMPS_ON_FIRST_SPREAD) };
  }
  const start = STAMPS_ON_FIRST_SPREAD + (spreadIndex - 1) * STAMPS_PER_FULL_SPREAD;
  return {
    left: all.slice(start, start + STAMPS_PER_PAGE),
    right: all.slice(start + STAMPS_PER_PAGE, start + STAMPS_PER_FULL_SPREAD),
  };
}

function applyTheme(svg: string, theme: PassportTheme): string {
  return svg.replaceAll("__INK__", theme.ink);
}

function renderSpreadBody(data: PassportData, spreadIndex: number, stamps: RenderedStamp[], theme: PassportTheme): string {
  const totalSpreads = spreadCountFor(stamps.length);
  const { left, right } = stampsForSpread(stamps, spreadIndex);
  const isFinal = spreadIndex === totalSpreads - 1;
  const finalPageIsRight = right.length > 0 || spreadIndex === 0;

  const leftPage = spreadIndex === 0
    ? renderIdentityPage(data)
    : renderStampsPage({
        stamps: left,
        originX: 60,
        originY: 60,
        pageNumber: spreadIndex * 2,
        isRight: false,
        isLastPage: isFinal && !finalPageIsRight,
        totalStamps: stamps.length,
      });

  const rightPage = renderStampsPage({
    stamps: right,
    originX: 480,
    originY: 60,
    pageNumber: spreadIndex * 2 + 1,
    isRight: true,
    isLastPage: isFinal && finalPageIsRight,
    totalStamps: stamps.length,
  });

  return `${renderSpreadBackground(theme)}${leftPage}${rightPage}`;
}

export function renderSpread(data: PassportData, spreadIndex: number): string {
  const theme = PASSPORT_THEMES[data.kind];
  const stamps = data.stamps.map(resolveStamp);
  return applyTheme(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SPREAD_WIDTH} ${SPREAD_HEIGHT}">
    ${renderDefs(theme)}
    ${renderSpreadBody(data, spreadIndex, stamps, theme)}
  </svg>`, theme);
}

export function renderPreview(data: PassportData): string {
  const theme = PASSPORT_THEMES[data.kind];
  const stamps = data.stamps.map(resolveStamp);
  const totalSpreads = spreadCountFor(stamps.length);
  const gutter = 24;
  const height = totalSpreads * SPREAD_HEIGHT + Math.max(0, totalSpreads - 1) * gutter;

  const spreads = Array.from({ length: totalSpreads }, (_, i) => {
    const y = i * (SPREAD_HEIGHT + gutter);
    return `<g transform="translate(0, ${y})">${renderSpreadBody(data, i, stamps, theme)}</g>`;
  }).join("\n");

  return applyTheme(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SPREAD_WIDTH} ${height}">
    ${renderDefs(theme)}
    ${spreads}
  </svg>`, theme);
}
