// GET /api/group-chat/[slug]/[building]
//
// Returns the last-hour message history for one house's group chat,
// plus a fresh Centrifugo subscribe token for the room channel. One
// fetch on entry covers both backfill + live-subscribe handshake; the
// client never has to plumb two round-trips.
//
// Auth: same gate as every other group-chat endpoint — viewer must be
// authorised for the town and the building must opt in. Anyone the
// access helper accepts (owner or visitor with cookie) can read.

import { mintSubscribeToken } from "@/lib/centrifugo";
import { prisma } from "@/lib/db";

import { HISTORY_WINDOW_MS, type GroupMessageRow } from "../types";
import {
  groupChatErrorResponse,
  resolveGroupChatAccess,
} from "./access";

type Params = { slug: string; building: string };

export async function GET(_req: Request, ctx: { params: Promise<Params> }) {
  const { slug, building } = await ctx.params;
  const access = await resolveGroupChatAccess(slug, building);
  if ("error" in access) return groupChatErrorResponse(access.error);

  const since = new Date(Date.now() - HISTORY_WINDOW_MS);
  const rows = await prisma.groupMessage.findMany({
    where: { channelId: access.channelId, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    take: 200, // cap so a chatty room can't ship a giant payload
  });

  let subscribeToken: string;
  try {
    subscribeToken = await mintSubscribeToken({
      sub: access.viewer.participantKey,
      channel: access.channelId,
    });
  } catch (e) {
    console.error("[group-chat.history] subscribe-token mint failed", e);
    return new Response(JSON.stringify({ error: "realtime-disabled" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const messages: GroupMessageRow[] = rows.map((r) => ({
    id: r.id,
    channelId: r.channelId,
    authorKey: r.authorKey,
    authorName: r.authorName,
    isNpc: r.isNpc,
    text: r.text,
    createdAt: r.createdAt.toISOString(),
  }));

  return new Response(
    JSON.stringify({
      channelId: access.channelId,
      subscribeToken,
      messages,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
