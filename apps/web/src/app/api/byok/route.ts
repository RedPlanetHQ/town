// /api/byok — user-scoped LLM key management.
//
//   GET               → list of providers the user has a key for
//                       (never returns the plaintext key)
//   POST { provider, apiKey } → upsert
//   DELETE { provider }        → remove
//
// Auth: session cookie only. Guests are 401.

import { NextResponse } from "next/server";

import {
  deleteModelKey,
  isBYOKProvider,
  listModelKeysForUser,
  saveModelKey,
} from "@/lib/byok/store";
import { getSessionFromCookie } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSessionFromCookie();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const keys = await listModelKeysForUser(session.userId);
  return NextResponse.json({
    keys: keys.map((k) => ({
      provider: k.provider,
      last4: k.last4,
      updatedAt: k.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const session = await getSessionFromCookie();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { provider?: string; apiKey?: string };
  try {
    body = (await req.json()) as { provider?: string; apiKey?: string };
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }

  if (!body.provider || !isBYOKProvider(body.provider)) {
    return NextResponse.json({ error: "bad-provider" }, { status: 400 });
  }
  if (!body.apiKey || typeof body.apiKey !== "string" || body.apiKey.trim().length < 8) {
    return NextResponse.json({ error: "bad-key" }, { status: 400 });
  }

  try {
    const saved = await saveModelKey(session.userId, body.provider, body.apiKey);
    return NextResponse.json({ provider: saved.provider, last4: saved.last4 });
  } catch (err) {
    console.error("[byok] save failed", err);
    return NextResponse.json({ error: "save-failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const session = await getSessionFromCookie();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { provider?: string };
  try {
    body = (await req.json()) as { provider?: string };
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  if (!body.provider || !isBYOKProvider(body.provider)) {
    return NextResponse.json({ error: "bad-provider" }, { status: 400 });
  }

  await deleteModelKey(session.userId, body.provider);
  return NextResponse.json({ ok: true });
}
