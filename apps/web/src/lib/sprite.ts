// Server-side helpers for user-uploaded sprite bytes.
//
// CustomPlots can reference either an existing catalog path
// ("exteriors/foo.png") or a user-uploaded ref ("sprite:<contentHash>").
// Uploads land in the `Sprite` table; reads come back through
// /api/sprites/<hash>.png.
//
// PNG validation is intentionally lightweight — magic bytes + IHDR
// dimensions. We don't decode pixel data; downstream we trust the file
// is renderable because the catalog and renderer already accept
// arbitrary PNGs.

import { createHash } from "node:crypto";

import { prisma } from "./db";

export const SPRITE_PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Max bytes for one uploaded sprite. Building sprites are typically
 *  5–30 KB; we cap generously to keep the row from ballooning if a user
 *  accidentally drops a screenshot in the folder. */
export const MAX_SPRITE_BYTES = 1 * 1024 * 1024; // 1 MiB

/** Max tile-equivalent dimensions. 32 tiles ≈ 512 px at TILE=16 — large
 *  enough for any plausible building, small enough to refuse mistakes. */
export const MAX_SPRITE_PX = 1024;

export interface SpriteValidationError {
  code: "too-large" | "not-png" | "bad-header" | "too-many-pixels";
  message: string;
}

export interface SpriteHeader {
  width: number;
  height: number;
}

/** Inspect the PNG header. Returns the dimensions, or an error if the
 *  bytes don't look like a sane PNG. */
export function readPngHeader(buf: Uint8Array): SpriteHeader | SpriteValidationError {
  if (buf.length > MAX_SPRITE_BYTES) {
    return {
      code: "too-large",
      message: `sprite is ${buf.length} bytes, max ${MAX_SPRITE_BYTES}`,
    };
  }
  if (buf.length < 24) {
    return { code: "not-png", message: "file is too short to be a PNG" };
  }
  for (let i = 0; i < SPRITE_PNG_MAGIC.length; i++) {
    if (buf[i] !== SPRITE_PNG_MAGIC[i]) {
      return { code: "not-png", message: "missing PNG magic bytes" };
    }
  }
  // IHDR chunk starts at byte 8. Bytes 16–19 = width, 20–23 = height (big-endian).
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) {
    return { code: "bad-header", message: "PNG dimensions cannot be zero" };
  }
  if (width > MAX_SPRITE_PX || height > MAX_SPRITE_PX) {
    return {
      code: "too-many-pixels",
      message: `PNG is ${width}×${height}, max ${MAX_SPRITE_PX} per side`,
    };
  }
  return { width, height };
}

/** Content hash used as the sprite's stable id. SHA-256 hex; we slice
 *  the first 32 chars for URL friendliness — collision odds stay
 *  cryptographically negligible at that length. */
export function spriteContentHash(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 32);
}

/** Upload (or no-op if already present) a sprite for one user. Idempotent
 *  on (userId, contentHash). */
export async function storeSpriteForUser(
  userId: string,
  buf: Uint8Array,
): Promise<{ contentHash: string; width: number; height: number; byteSize: number }> {
  const header = readPngHeader(buf);
  if ("code" in header) {
    throw new SpriteUploadError(header.code, header.message);
  }
  const contentHash = spriteContentHash(buf);
  const existing = await prisma.sprite.findUnique({
    where: { userId_contentHash: { userId, contentHash } },
    select: { contentHash: true, width: true, height: true, byteSize: true },
  });
  if (existing) return existing;
  await prisma.sprite.create({
    data: {
      userId,
      contentHash,
      bytes: Buffer.from(buf),
      width: header.width,
      height: header.height,
      byteSize: buf.length,
    },
  });
  return {
    contentHash,
    width: header.width,
    height: header.height,
    byteSize: buf.length,
  };
}

export class SpriteUploadError extends Error {
  code: SpriteValidationError["code"];
  constructor(code: SpriteValidationError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "SpriteUploadError";
  }
}

/** Look up a sprite by content hash. Any user can serve any sprite —
 *  the URL is content-addressed so leaking it is no worse than embedding
 *  the bytes inline. */
export async function findSpriteByHash(
  contentHash: string,
): Promise<{ bytes: Buffer; width: number; height: number } | null> {
  const row = await prisma.sprite.findFirst({
    where: { contentHash },
    select: { bytes: true, width: true, height: true },
  });
  if (!row) return null;
  return {
    bytes: Buffer.from(row.bytes),
    width: row.width,
    height: row.height,
  };
}
