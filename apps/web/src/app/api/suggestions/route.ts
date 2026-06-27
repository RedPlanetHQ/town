// /api/suggestions
//
//   GET ?slug=<slug>          → { suggestions, count } for the town.
//                               Pending only; newest first.
//   GET ?slug=<slug>&probe=1  → cheap polling: just { count } of pending.
//
// Multi-town: the caller passes the active town's slug. Without it,
// resolveTownForOwner falls back to the user's only town (or 400 if
// they own multiple).

import { NextResponse } from "next/server";

import { resolveUser } from "@/lib/auth-bearer";
import { resolveTownForOwner } from "@/lib/resolve-town";
import {
  countPendingSuggestions,
  listPendingSuggestions,
} from "@/lib/town/suggestions";

export async function GET(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const r = await resolveTownForOwner(req, resolved.user.id);
  if (!r.ok) return NextResponse.json(r.body, { status: r.status });

  const url = new URL(req.url);
  if (url.searchParams.has("probe")) {
    const count = await countPendingSuggestions(r.townId);
    return NextResponse.json({ count });
  }
  const suggestions = await listPendingSuggestions(r.townId);
  return NextResponse.json({
    suggestions,
    count: suggestions.length,
  });
}
