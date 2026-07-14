// Shared shell for the plain info pages (/feedback, /explore, /passport,
// /dashboard) so they stay visually locked to the same dark theme:
// bg-black, paper text, uppercase tracking, `text-primary` accent for a
// highlighted word, and a session-aware back link at the top-left.
//
// Back link defaults:
//   • signed in  → "← Back to dashboard"  (/dashboard)
//   • signed out → "← Back to town"       (/)
//
// Callers can still override via `backHref` / `backLabel` when a page
// wants to point somewhere specific.

import type { ReactNode } from "react";

import { getSessionFromCookie } from "@/lib/session";

type MaxWidth = "2xl" | "3xl" | "4xl";

const MAX_WIDTH_CLASS: Record<MaxWidth, string> = {
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
};

export async function InfoPageShell({
  backHref,
  backLabel,
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
  // Only resolve defaults when the caller didn't override — avoids a
  // pointless cookie read on pages that explicitly point elsewhere.
  let resolvedHref = backHref;
  let resolvedLabel = backLabel;
  if (!resolvedHref || !resolvedLabel) {
    const session = await getSessionFromCookie();
    if (session) {
      resolvedHref = resolvedHref ?? "/dashboard";
      resolvedLabel = resolvedLabel ?? "← Back to dashboard";
    } else {
      resolvedHref = resolvedHref ?? "/";
      resolvedLabel = resolvedLabel ?? "← Back to town";
    }
  }
  return (
    <main className="min-h-screen bg-black px-4 py-10 text-paper">
      <div
        className={`mx-auto flex w-full ${MAX_WIDTH_CLASS[maxWidth]} flex-col gap-8`}
      >
        <a
          href={resolvedHref}
          className="self-start text-xs font-bold uppercase tracking-wider text-paper/70 hover:text-paper"
        >
          {resolvedLabel}
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
