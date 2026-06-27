// /api/plot — read + write a plot.
//
//   GET  /api/plot                 → caller's own plot (single town only)
//   GET  /api/plot?slug=<slug>     → caller's plot for that slug (multi-town
//                                    callers MUST supply this)
//   GET  /api/plot?probe=1         → just the version (cheap polling)
//   GET  /api/plot?town=<slug>     → that town's plot (owner OR valid
//                                    visitor-cookie holder). Read-only —
//                                    POST always targets the caller's own
//                                    plot.
//   POST /api/plot { plot }        → replace caller's plot (use ?slug= to
//                                    pick when the caller owns N towns)
//
// Visitors gain access by passing the share code through /api/towns/{slug}/visit,
// which drops a per-slug cookie. We never gate on that cookie's payload —
// only on its presence — because the gate already verified the code.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { resolveUser } from "@/lib/auth-bearer";
import { loadManifest } from "@/lib/manifest";
import {
  getPlotForTown,
  savePlotForTown,
  getPlotVersionForTown,
} from "@/lib/plot";
import { resolveTownForOwner } from "@/lib/resolve-town";
import { getTownBySlug } from "@/lib/town";
import { parseVisitorCookie, visitorCookieName } from "@/lib/town-code";
import type { Plot } from "@town/plot";
import { validatePlot } from "@town/plot";

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

export async function POST(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { plot?: Plot };
  try {
    body = (await req.json()) as { plot?: Plot };
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const plot = body.plot;
  if (!plot) {
    return NextResponse.json({ error: "missing plot" }, { status: 400 });
  }
  const check = validatePlot(plot, loadManifest());
  if (!check.ok) {
    return NextResponse.json(
      { error: "validation-failed", issues: check.issues },
      { status: 400 },
    );
  }
  const r = await resolveTownForOwner(req, resolved.user.id);
  if (!r.ok) return NextResponse.json(r.body, { status: r.status });
  const { version } = await savePlotForTown(r.townId, plot);
  return NextResponse.json({ version });
}
