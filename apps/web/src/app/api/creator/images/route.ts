// POST /api/creator/images — CLI-facing image generation.
//
// Used by `town generate exterior|interior` to produce a single PNG
// against a town's aura budget WITHOUT going through the streaming
// creator chat. Simpler contract than the chat tools:
//
//   • Debits IMAGE_GEN_AURA_COST aura in the same transaction that
//     stores the sprite bytes — so aura empty aborts before we bill
//     the OpenAI call.
//   • Returns the PNG bytes (base64) inline so the CLI can spinner
//     one HTTP round-trip and write the file. Also returns
//     `auraConsumed` + `auraRemaining` so the CLI can show cost.
//   • Does NOT stage anything in `Town.pendingChanges` — the CLI
//     writes bytes to disk directly and the existing `town deploy`
//     path uploads them under a normal sprite hash later.
//
// Body:
//   { kind: "exterior" | "interior",
//     concept: string,           // 1-3 sentences
//     category: PlotCategory,    // HOME | WORK | ...
//     slug?: string,             // town slug; falls back to resolveTownForOwner
//     exteriorTiles?: { w, h } } // exterior only, default 12×12
//
// Response 200:
//   { kind, widthTiles, heightTiles, contentHash, pngBase64,
//     auraConsumed, auraRemaining, byteSize }
//
// Response 402: `{ error: "aura-empty", auraRemaining }` — the aura
// row didn't have enough to cover the debit. No OpenAI call was made.

import { NextResponse } from "next/server";

import { resolveUser } from "@/lib/auth-bearer";
import { prisma } from "@/lib/db";
import { resolveTownForOwner } from "@/lib/resolve-town";
import {
  EXTERIOR_DEFAULT_H,
  EXTERIOR_DEFAULT_W,
  EXTERIOR_MAX,
  EXTERIOR_MIN,
  IMAGE_GEN_AURA_COST,
  INTERIOR_TILES_H,
  INTERIOR_TILES_W,
  generateExteriorPng,
  generateInteriorPng,
  type PlotCategory,
} from "@/lib/creator/image-gen";
import { storeSpriteForUser } from "@/lib/sprite";

export const dynamic = "force-dynamic";

const CATEGORIES: PlotCategory[] = [
  "HOME",
  "WORK",
  "READ",
  "MARKET",
  "MOVE",
  "CREATE",
  "WORKSHOP",
];

type ImageKind = "exterior" | "interior";

interface RequestBody {
  kind?: ImageKind;
  concept?: string;
  category?: string;
  slug?: string;
  exteriorTiles?: { w?: number; h?: number };
}

function invalid(field: string, detail?: string) {
  return NextResponse.json(
    { error: "bad-request", field, detail },
    { status: 400 },
  );
}

export async function POST(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }

  if (body.kind !== "exterior" && body.kind !== "interior") {
    return invalid("kind", "must be 'exterior' or 'interior'");
  }
  const kind: ImageKind = body.kind;

  const concept = (body.concept ?? "").trim();
  if (concept.length < 4 || concept.length > 400) {
    return invalid("concept", "must be 4–400 characters");
  }

  if (!body.category || !CATEGORIES.includes(body.category as PlotCategory)) {
    return invalid("category", `must be one of ${CATEGORIES.join(", ")}`);
  }
  const category = body.category as PlotCategory;

  let tilesW = EXTERIOR_DEFAULT_W;
  let tilesH = EXTERIOR_DEFAULT_H;
  if (kind === "exterior" && body.exteriorTiles) {
    const w = body.exteriorTiles.w;
    const h = body.exteriorTiles.h;
    if (
      typeof w !== "number" ||
      typeof h !== "number" ||
      !Number.isInteger(w) ||
      !Number.isInteger(h) ||
      w < EXTERIOR_MIN ||
      w > EXTERIOR_MAX ||
      h < EXTERIOR_MIN ||
      h > EXTERIOR_MAX
    ) {
      return invalid(
        "exteriorTiles",
        `each side must be an integer in [${EXTERIOR_MIN}, ${EXTERIOR_MAX}]`,
      );
    }
    tilesW = w;
    tilesH = h;
  }

  // Rebuild the same slug-resolution surface the streaming route uses.
  // For CLI callers `?slug=` is idiomatic; body.slug is accepted as a
  // convenience so the CLI doesn't have to URL-encode it.
  const url = new URL(req.url);
  if (body.slug && !url.searchParams.get("slug")) {
    url.searchParams.set("slug", body.slug);
  }
  const proxyReq = new Request(url.toString(), req);
  const townRes = await resolveTownForOwner(proxyReq, resolved.user.id);
  if (!townRes.ok) {
    return NextResponse.json(townRes.body, { status: townRes.status });
  }
  const townId = townRes.townId;

  // Aura preflight — refuse before the model call if the town can't
  // cover the debit. We check-then-debit in a single transaction below
  // to keep it atomic under concurrent requests.
  const aura = await prisma.aura.findUnique({ where: { townId } });
  if (!aura || aura.current < IMAGE_GEN_AURA_COST) {
    return NextResponse.json(
      {
        error: "aura-empty",
        auraRemaining: aura?.current ?? 0,
        auraCost: IMAGE_GEN_AURA_COST,
      },
      { status: 402 },
    );
  }

  // Generate the PNG. Any provider failure surfaces as 502 — no aura
  // is debited because the debit happens after this returns.
  let png: Buffer;
  try {
    png =
      kind === "exterior"
        ? await generateExteriorPng({ concept, category, tilesW, tilesH })
        : await generateInteriorPng({ concept, category });
  } catch (e) {
    return NextResponse.json(
      {
        error: "image-gen-failed",
        detail: e instanceof Error ? e.message : "unknown",
      },
      { status: 502 },
    );
  }

  // Store the sprite bytes so subsequent `town deploy` runs can reuse
  // the hash (idempotent on userId + contentHash). This is separate
  // from the aura debit — the sprite is cached even if the debit ends
  // up racing to zero.
  const stored = await storeSpriteForUser(
    resolved.user.id,
    new Uint8Array(png),
  );

  // Debit aura. Concurrent requests can race the preflight to zero;
  // the row's `current` becomes negative in that case and we refund
  // (add back) + report aura-empty. This is rare enough that the
  // extra round-trip cost is acceptable.
  const debited = await prisma.aura.update({
    where: { townId },
    data: { current: { decrement: IMAGE_GEN_AURA_COST } },
    select: { current: true },
  });
  if (debited.current < 0) {
    await prisma.aura.update({
      where: { townId },
      data: { current: { increment: IMAGE_GEN_AURA_COST } },
    });
    return NextResponse.json(
      {
        error: "aura-empty",
        auraRemaining: 0,
        auraCost: IMAGE_GEN_AURA_COST,
      },
      { status: 402 },
    );
  }

  const widthTiles = kind === "exterior" ? tilesW : INTERIOR_TILES_W;
  const heightTiles = kind === "exterior" ? tilesH : INTERIOR_TILES_H;

  return NextResponse.json({
    kind,
    widthTiles,
    heightTiles,
    contentHash: stored.contentHash,
    byteSize: stored.byteSize,
    pngBase64: png.toString("base64"),
    auraConsumed: IMAGE_GEN_AURA_COST,
    auraRemaining: debited.current,
  });
}
