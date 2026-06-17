// /api/sprites — upload a PNG to the caller's sprite store. Used by
// `town deploy` when a CustomPlot references a local PNG file:
//
//   POST /api/sprites      content-type: image/png
//   body: <raw PNG bytes>
//
// → { contentHash, width, height, byteSize }
//
// Idempotent on (userId, contentHash); a re-upload returns the existing
// row. Reads come back through /api/sprites/<hash>.png.

import { NextResponse } from "next/server";

import { resolveUser } from "@/lib/auth-bearer";
import { SpriteUploadError, storeSpriteForUser, MAX_SPRITE_BYTES } from "@/lib/sprite";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_SPRITE_BYTES) {
    return NextResponse.json(
      { error: "too-large", detail: `max ${MAX_SPRITE_BYTES} bytes` },
      { status: 413 },
    );
  }
  let buf: ArrayBuffer;
  try {
    buf = await req.arrayBuffer();
  } catch {
    return NextResponse.json({ error: "bad-body" }, { status: 400 });
  }
  if (buf.byteLength === 0) {
    return NextResponse.json({ error: "empty-body" }, { status: 400 });
  }
  try {
    const result = await storeSpriteForUser(resolved.user.id, new Uint8Array(buf));
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof SpriteUploadError) {
      return NextResponse.json(
        { error: e.code, detail: e.message },
        { status: 400 },
      );
    }
    throw e;
  }
}
