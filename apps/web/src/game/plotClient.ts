// Client-side plot fetcher + polling subscriber.
//
// The kaplay scene calls loadPlot() once at scene start to render, then
// subscribes via subscribePlot() so it re-enters itself whenever the
// stored plot version changes. The polling cadence is intentionally
// generous (3s) — plot edits aren't real-time-critical, and the probe
// endpoint returns only the version int so it's cheap.
//
// Two slug slots, mutually exclusive:
//   • viewerTownSlug → visitor mode → /api/plot?town=<slug>. The
//     server gates on a per-slug visitor cookie.
//   • ownerTownSlug → owner mode → /api/plot?slug=<slug>. Required
//     when the owner holds multiple towns; the server returns
//     `missing-slug` otherwise.
// Setting one clears the other so we never send both query params.

import type { Plot } from "@town/plot";

const POLL_MS = 3000;

export interface PlotPayload {
  plot: Plot;
  version: number;
}

let activeAbort: AbortController | null = null;
let viewerTownSlug: string | null = null;
let ownerTownSlug: string | null = null;
let cachedPlot: Plot | null = null;

export function setViewerTownSlug(slug: string | null): void {
  viewerTownSlug = slug;
  if (slug) ownerTownSlug = null;
}

/** Owner-mode setter. Tells plotClient which of the caller's owned
 *  towns to fetch — required for multi-town owners because the server
 *  refuses an ambiguous /api/plot otherwise. Single-town owners can
 *  still set this; the server treats `?slug=<the only one>` identically
 *  to no slug. */
export function setOwnerTownSlug(slug: string | null): void {
  ownerTownSlug = slug;
  if (slug) viewerTownSlug = null;
}

/** Stash the active plot so other scenes (interior) can read its slot
 *  data without round-tripping /api/plot again. The overworld sets this
 *  whenever a fresh plot lands; interiors read it on entry. */
export function setCachedPlot(plot: Plot | null): void {
  cachedPlot = plot;
}

export function getCachedPlot(): Plot | null {
  return cachedPlot;
}

/** True when the active viewer is looking at their own town. Used by
 *  scenes that want to gate owner-only content (e.g. the system
 *  Founder NPC stays hidden when a visitor walks into the store). */
export function isViewerOwner(): boolean {
  return viewerTownSlug === null;
}

/** The slug of the town the viewer is currently touring, or null when
 *  they're on their own town. Surfaces context that React-side flows
 *  (e.g. the NPC chat transport) need to hand to the server. */
export function getViewerTownSlug(): string | null {
  return viewerTownSlug;
}

/** The slug of the owner's currently-active town when the page is an
 *  owner-mode view, otherwise null. Mirrors getViewerTownSlug for the
 *  owner path so multi-town owners can address their current town
 *  from any subsystem (NPC fetch, share-code fetch, etc.). */
export function getOwnerTownSlug(): string | null {
  return ownerTownSlug;
}

/** Active town slug regardless of viewer/owner mode. Returns whichever
 *  of the two slots is currently set, or null when neither is (e.g.
 *  the guest playground at `/`). Useful for callers that just need
 *  "what town is this page about" without caring about the mode. */
export function getActiveTownSlug(): string | null {
  return viewerTownSlug ?? ownerTownSlug;
}

function url(probe: boolean): string {
  const qs = new URLSearchParams();
  if (viewerTownSlug) {
    qs.set("town", viewerTownSlug);
  } else if (ownerTownSlug) {
    // Owner-mode: disambiguate which of the caller's towns to fetch.
    // Without this, multi-town owners get `missing-slug` back from
    // /api/plot and the canvas never paints.
    qs.set("slug", ownerTownSlug);
  }
  if (probe) qs.set("probe", "1");
  const q = qs.toString();
  return q ? `/api/plot?${q}` : "/api/plot";
}

export async function loadPlot(): Promise<PlotPayload | null> {
  try {
    const res = await fetch(url(false), { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as PlotPayload;
  } catch {
    return null;
  }
}

/** Long-poll wrapper: fires `onChange` every time the stored plot's version
 *  bumps past the one passed in. Returns an unsubscribe. */
export function subscribePlot(
  initialVersion: number,
  onChange: (payload: PlotPayload) => void,
): () => void {
  if (activeAbort) activeAbort.abort();
  const abort = new AbortController();
  activeAbort = abort;
  let lastVersion = initialVersion;
  let stopped = false;

  async function loop() {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (stopped) break;
      try {
        const probe = await fetch(url(true), {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!probe.ok) continue;
        const { version } = (await probe.json()) as { version: number | null };
        if (version === null || version === lastVersion) continue;
        const full = await fetch(url(false), {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!full.ok) continue;
        const payload = (await full.json()) as PlotPayload;
        lastVersion = payload.version;
        onChange(payload);
      } catch {
        // Network blip — try again next tick.
      }
    }
  }
  void loop();

  return () => {
    stopped = true;
    abort.abort();
    if (activeAbort === abort) activeAbort = null;
  };
}
