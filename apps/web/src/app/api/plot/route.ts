// /api/plot — read a plot.
//
//   GET  /api/plot                 → caller's own plot (single town, or
//                                    falls back to active-slug cookie
//                                    via resolveTownForOwner)
//   GET  /api/plot?slug=<slug>     → caller's plot for that slug (multi-town
//                                    callers can supply this explicitly)
//   GET  /api/plot?probe=1         → just the version (cheap polling)
//   GET  /api/plot?town=<slug>     → that town's plot (owner OR valid
//                                    visitor-cookie holder)
//
// Visitors gain access by passing the share code through /api/towns/{slug}/visit,
// which drops a per-slug cookie. We never gate on that cookie's payload —
// only on its presence — because the gate already verified the code.
//
// POST was removed in the multi-town sweep — `town deploy` consolidated
// into `/api/town` POST (which runs the same diff/apply pipeline plus
// sprite uploads + customPlot wiring). No remaining callers.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { resolveUser } from "@/lib/auth-bearer";
import {
  getPlotForTown,
  getPlotVersionForTown,
} from "@/lib/plot";
import { resolveTownForOwner } from "@/lib/resolve-town";
import { getTownBySlug } from "@/lib/town";
import { parseVisitorCookie, visitorCookieName } from "@/lib/town-code";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const townSlug = url.searchParams.get("town");
  const isProbe = url.searchParams.has("probe");

  if (townSlug) {
    const town = await getTownBySlug(townSlug);
    if (!town) {
      return NextResponse.json({ error: "not-found" }, { status: 404 });
    }
    // Owner can always view; everyone else needs a per-slug visitor cookie.
    const session = await resolveUser(req);
    const isOwner = !!session && session.user.id === town.ownerId;
    if (!isOwner) {
      const jar = await cookies();
      const cookie = parseVisitorCookie(jar.get(visitorCookieName(townSlug))?.value);
      // Cookie has to be present AND carry the town's current share code —
      // a Reset in the Share modal invalidates older codes immediately.
      if (!cookie || cookie.c !== town.shareCode) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
    if (isProbe) {
      const version = await getPlotVersionForTown(town.id);
      return NextResponse.json({ version });
    }
    const { plot, version } = await getPlotForTown(town.id);
    return NextResponse.json({ plot, version });
  }

  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const r = await resolveTownForOwner(req, resolved.user.id);
  if (!r.ok) return NextResponse.json(r.body, { status: r.status });
  if (isProbe) {
    const version = await getPlotVersionForTown(r.townId);
    return NextResponse.json({ version });
  }
  const { plot, version } = await getPlotForTown(r.townId);
  return NextResponse.json({ plot, version });
}

