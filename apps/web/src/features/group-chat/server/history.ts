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
// Filtering: only messages in #general (topicId=null) or in currently
// active topics come back. Messages belonging to expired topics are
// invisible even if they still sit in the table, so the client can
// bucket by topicId without ever seeing a ghost thread.

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
import { loadActiveTopics } from "./topics";

type Params = { slug: string; building: string };

export async function GET(_req: Request, ctx: { params: Promise<Params> }) {
  const { slug, building } = await ctx.params;
  const access = await resolveGroupChatAccess(slug, building);
  if ("error" in access) return groupChatErrorResponse(access.error);

  const since = new Date(Date.now() - HISTORY_WINDOW_MS);
  const topics: GroupTopicRow[] = await loadActiveTopics(access.channelId);
  const activeTopicIds = topics.map((t) => t.id);

  // Match messages in #general OR in one of the active topics. This
  // filters out rows tied to topics that have expired inside the
  // 1-hour window so the client doesn't render a bucket with no
  // sidebar entry.
  const rows = await prisma.groupMessage.findMany({
    where: {
      channelId: access.channelId,
      createdAt: { gte: since },
      OR: [
        { topicId: null },
        ...(activeTopicIds.length > 0
          ? [{ topicId: { in: activeTopicIds } }]
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
