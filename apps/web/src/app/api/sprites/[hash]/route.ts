// /api/sprites/<hash>.png — serve a user-uploaded sprite by its content
// hash. Content-addressed URLs are safe to leak (the bytes are not
// secret) so we don't gate this on auth; the renderer hits it whenever a
// CustomPlot sprite ref is "sprite:<hash>". Cached forever — the URL
// changes whenever the bytes change.

import { NextResponse } from "next/server";

import { findSpriteByHash } from "@/lib/sprite";

interface Params {
  params: Promise<{ hash: string }>;
}

export async function GET(_req: Request, ctx: Params) {
  const { hash: raw } = await ctx.params;
  const hash = raw.endsWith(".png") ? raw.slice(0, -4) : raw;
  if (!/^[a-f0-9]{8,128}$/.test(hash)) {
    return NextResponse.json({ error: "bad-hash" }, { status: 400 });
  }
  const row = await findSpriteByHash(hash);
  if (!row) return NextResponse.json({ error: "not-found" }, { status: 404 });
  return new NextResponse(new Uint8Array(row.bytes), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "content-length": String(row.bytes.length),
      // Bytes are immutable for this URL — the hash IS the address.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
