// Small SVG icons shared by the three chat surfaces (Chat, Dm,
// GroupChatSurface). Unicode arrow glyphs (⤢ ⤡ ×) render tiny in a
// 36px button — SVGs give predictable sizing and consistent stroke
// weight across surfaces.

import type { SVGProps } from "react";

const baseProps: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.25,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export function ExpandIcon({ className = "h-4 w-4" }: { className?: string }) {
  // Two diagonal arrows pointing to opposite corners.
  return (
    <svg {...baseProps} className={className}>
      <path d="M15 3h6v6" />
      <path d="M21 3l-8 8" />
      <path d="M9 21H3v-6" />
      <path d="M3 21l8-8" />
    </svg>
  );
}

export function RestoreIcon({ className = "h-4 w-4" }: { className?: string }) {
  // Two diagonal arrows pointing inward to opposite corners.
  return (
    <svg {...baseProps} className={className}>
      <path d="M4 14h6v6" />
      <path d="M4 20l6.5-6.5" />
      <path d="M20 10h-6V4" />
      <path d="M20 4l-6.5 6.5" />
    </svg>
  );
}

export function CloseIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

export function PlusIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}
