"use client";

// Full-width bar pinned to the bottom of the viewport. Houses two
// halves:
//   • Left: "Town from core" attribution — open-source credit that
//     travels with every deployed instance.
//   • Right: single-row rotating ticker (last ~10 events) + "Town
//     activity" toggle; the ticker feeds off useTownActivity.
//
// The bar is the source of truth for the activity poll; the popover
// (ActivityFeed) shares the same items via props so we don't fire two
// requests for the same data.

import { ActivityFeed } from "./ActivityFeed";
import { ActivityTicker } from "./ActivityTicker";
import { ui } from "./store";
import { useTownActivity } from "./useTownActivity";

export interface BottomBarProps {
  /** Slug of the town this bar is observing. When omitted (the guest
   *  playground at `/`) the activity panel + ticker silently render
   *  their empty states. */
  townSlug: string | undefined;
  /** Whether the city-activity popover is currently open. Drives the
   *  toggle's highlight + the popover's visibility. */
  feedOpen: boolean;
}

export function BottomBar({ townSlug, feedOpen }: BottomBarProps) {
  const { items, status } = useTownActivity(townSlug);

  return (
    <>
      {feedOpen && townSlug ? (
        <ActivityFeed items={items} status={status} />
      ) : null}
      <div
        className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex h-7 items-center justify-between border-t-2 border-paper/10 bg-[#0e1116] px-3 text-paper"
        role="contentinfo"
      >
        <div className="flex shrink-0 items-center gap-3 text-xs font-bold uppercase tracking-wider text-paper/70">
          <div>
            <a
              href="https://github.com/redplanethq/town"
              target="_blank"
              rel="noopener noreferrer"
              className="underline-offset-2 hover:underline"
            >
              Town
            </a>
            <span className="mx-1 opacity-60">from</span>
            <a
              href="https://github.com/redplanethq/core"
              target="_blank"
              rel="noopener noreferrer"
              className="underline-offset-2 hover:underline"
            >
              core
            </a>
          </div>
          <span className="opacity-30">·</span>
          <a
            href="/feedback"
            className="underline-offset-2 hover:text-paper hover:underline"
          >
            Feedback
          </a>
        </div>
        <div className="ml-3 flex min-w-0 flex-1 items-center justify-end gap-3">
          <div className="min-w-0 flex-1 truncate text-right">
            {townSlug ? <ActivityTicker items={items} /> : null}
          </div>
          <button
            type="button"
            onClick={() => ui.toggleFeed()}
            className="flex shrink-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-xs font-bold uppercase tracking-wider hover:bg-white/5"
            aria-pressed={feedOpen}
            aria-label={feedOpen ? "Hide town activity" : "Show town activity"}
            title={feedOpen ? "Hide town activity" : "Show town activity"}
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: "#dcb016" }}
            />
            Town activity
          </button>
        </div>
      </div>
    </>
  );
}
