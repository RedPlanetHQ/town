// /api/towns/[slug]/dm/[other]
//
//   GET  → { conversationId, viewerKey, otherKey, pendingFromKey, messages: [{id, fromKey, text, createdAt}] }
//   POST { text } → { message: {...} } and live-fans-out via Centrifugo
//
// Only the two participants of the conversation can read or write — the
// town owner has no special access. The viewer's participant key is
// derived from the cookie/session via resolveViewer; the other party's
// key comes from the URL path.

import { NextResponse } from "next/server";

import { dmChannel, publish, userInboxChannel } from "@/lib/centrifugo";
import {
  appendMessage,
  findOrCreateConversation,
  listMessages,
  sortParticipantKeys,
} from "@/lib/conversation";
import { prisma } from "@/lib/db";
import { resolveViewer } from "@/lib/viewer";

type Params = { slug: string; other: string };

const MAX_TEXT = 2000;

export async function GET(_req: Request, ctx: { params: Promise<Params> }) {
  const { slug, other } = await ctx.params;
  const viewer = await resolveViewer(slug);
  if ("error" in viewer) {
    return NextResponse.json(
      { error: viewer.error },
      { status: viewer.error === "forbidden" ? 403 : 404 },
    );
  }
  const otherKey = decodeURIComponent(other);
  if (otherKey === viewer.participantKey) {
    return NextResponse.json({ error: "self-dm" }, { status: 400 });
  }

  // GET is read-only — never upsert here. A third party who knows the
  // URL pattern would otherwise drop blank Conversation rows. The first
  // POST upserts; until then this just returns an empty thread.
  const [aKey, bKey] = sortParticipantKeys(viewer.participantKey, otherKey);
  const conv = await prisma.conversation.findUnique({
    where: { townId_aKey_bKey: { townId: viewer.town.id, aKey, bKey } },
  });
  if (!conv) {
    return NextResponse.json({
      conversationId: null,
      viewerKey: viewer.participantKey,
      otherKey,
      pendingFromKey: null,
      messages: [],
    });
  }
  const messages = await listMessages(conv.id);
  return NextResponse.json({
    conversationId: conv.id,
    viewerKey: viewer.participantKey,
    otherKey,
    pendingFromKey: conv.pendingFromKey,
    messages: messages.map((m) => ({
      id: m.id,
      fromKey: m.fromKey,
      text: m.text,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: Request, ctx: { params: Promise<Params> }) {
  const { slug, other } = await ctx.params;
  const viewer = await resolveViewer(slug);
  if ("error" in viewer) {
    return NextResponse.json(
      { error: viewer.error },
      { status: viewer.error === "forbidden" ? 403 : 404 },
    );
  }
  const otherKey = decodeURIComponent(other);
  if (otherKey === viewer.participantKey) {
    return NextResponse.json({ error: "self-dm" }, { status: 400 });
  }

  let body: { text?: string };
  try {
    body = (await req.json()) as { text?: string };
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400 });
  if (text.length > MAX_TEXT) {
    return NextResponse.json({ error: "too-long" }, { status: 400 });
  }

  const conv = await findOrCreateConversation(
    viewer.town.id,
    viewer.participantKey,
    otherKey,
  );
  const msg = await appendMessage({
    conversationId: conv.id,
    fromKey: viewer.participantKey,
    text,
  });

  // Two-channel fan-out:
  //   1. dm:<...>  — the per-conversation channel the open DM panel
  //      subscribes to. Receives the full message body so the panel can
  //      append it without a re-fetch.
  //   2. user:<otherKey> — the recipient's persistent inbox channel,
  //      subscribed once on game boot. Receives a tiny envelope used to
  //      ding the notification sound + flip the pending dot, regardless
  //      of which (or whether any) DM panel is currently open.
  // Sender doesn't get an inbox publication — they sent it.
  await Promise.all([
    publish(
      dmChannel(slug, viewer.participantKey, otherKey),
      {
        id: msg.id,
        fromKey: msg.fromKey,
        text: msg.text,
        createdAt: msg.createdAt.toISOString(),
      },
    ),
    publish(userInboxChannel(otherKey), {
      type: "dm",
      messageId: msg.id,
      conversationId: conv.id,
      fromKey: msg.fromKey,
      // Sender's display name as resolved server-side. Lets the
      // OS notification render "Harshith: hey…" without a name lookup
      // on the receiver — the sender may not be a visible remote at
      // all (e.g. just walked off-screen).
      fromName: viewer.displayName,
      townSlug: slug,
      preview: msg.text.slice(0, 120),
      createdAt: msg.createdAt.toISOString(),
    }),
  ]);

  return NextResponse.json({
    message: {
      id: msg.id,
      fromKey: msg.fromKey,
      text: msg.text,
      createdAt: msg.createdAt.toISOString(),
    },
  });
}
