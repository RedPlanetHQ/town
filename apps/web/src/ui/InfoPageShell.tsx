// Shared shell for the plain info pages (/feedback, /explore) so they
// stay visually locked to the same dark theme: bg-black, paper text,
// uppercase tracking, `text-primary` accent for a highlighted word,
// and a "← Back to city" link at the top-left.
//
// Kept intentionally simple — no header actions, no right-aligned
// meta. Pages that need extra top-bar surface (a tab switcher, a
// filter row, per-page metadata) can render it inside `children`
// under the header.

import type { ReactNode } from "react";

type MaxWidth = "2xl" | "3xl" | "4xl";

const MAX_WIDTH_CLASS: Record<MaxWidth, string> = {
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
};

export function InfoPageShell({
  backHref = "/",
  backLabel = "← Back to city",
  title,
  subtitle,
  maxWidth = "2xl",
  children,
}: {
  backHref?: string;
  backLabel?: string;
  /** Title node — usually plain text with an inline <span className="text-primary"> accent. */
  title: ReactNode;
  subtitle?: ReactNode;
  maxWidth?: MaxWidth;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-black px-4 py-10 text-paper">
      <div
        className={`mx-auto flex w-full ${MAX_WIDTH_CLASS[maxWidth]} flex-col gap-8`}
      >
        <a
          href={backHref}
          className="self-start text-xs font-bold uppercase tracking-wider text-paper/70 hover:text-paper"
        >
          {backLabel}
        </a>

        <header className="flex flex-col gap-3">
          <h1 className="text-2xl font-bold uppercase tracking-wider">
            {title}
          </h1>
          {subtitle ? (
            <p className="text-sm uppercase tracking-wider text-paper/60">
              {subtitle}
            </p>
          ) : null}
        </header>

        {children}
      </div>
    </main>
  );
}
