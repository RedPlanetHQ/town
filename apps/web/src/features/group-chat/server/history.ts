// GET /api/group-chat/[slug]/[building]
//
// Returns the last-hour message history for one house's group chat,
// the active topics list, plus a fresh Centrifugo subscribe token for
// the room channel. One fetch on entry covers backfill + topics list
// + live-subscribe handshake; the client never has to plumb three
// round-trips.
//
// Auth: same gate as every other group-chat endpoint — viewer must be
// authorised for the town and the building must opt in. Anyone the
// access helper accepts (owner or visitor with cookie) can read.
//
// Filtering: messages in #general (topicId=null), currently active
// topics, and recently-expired topics (still inside HISTORY_WINDOW_MS)
// all come back. Expired topics render read-only in the sidebar so
// players can scroll old conversations without being able to post.

import { mintSubscribeToken } from "@/lib/centrifugo";
import { prisma } from "@/lib/db";

import {
  HISTORY_WINDOW_MS,
  type GroupMessageRow,
  type GroupTopicRow,
} from "../types";
import {
  groupChatErrorResponse,
  resolveGroupChatAccess,
} from "./access";
import { loadRecentTopics } from "./topics";

type Params = { slug: string; building: string };

export async function GET(_req: Request, ctx: { params: Promise<Params> }) {
  const { slug, building } = await ctx.params;
  const access = await resolveGroupChatAccess(slug, building);
  if ("error" in access) return groupChatErrorResponse(access.error);

  const since = new Date(Date.now() - HISTORY_WINDOW_MS);
  const topics: GroupTopicRow[] = await loadRecentTopics(access.channelId);
  const visibleTopicIds = topics.map((t) => t.id);

  // Match messages in #general OR in any topic still visible on the
  // sidebar (active + recently-expired). Rows tied to topics that
  // aged past the window drop off so the client never sees a bucket
  // without a matching sidebar row.
  const rows = await prisma.groupMessage.findMany({
    where: {
      channelId: access.channelId,
      createdAt: { gte: since },
      OR: [
        { topicId: null },
        ...(visibleTopicIds.length > 0
          ? [{ topicId: { in: visibleTopicIds } }]
          : []),
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 400, // cap so a chatty room can't ship a giant payload
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
    topicId: r.topicId,
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
      topics,
      ownerParticipantKey: access.ownerParticipantKey,
      ownerName: access.ownerName,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
