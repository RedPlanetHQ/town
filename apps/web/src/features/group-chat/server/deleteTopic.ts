// DELETE /api/group-chat/[slug]/[building]/topics/[topicId]
//
// Owner-only. Sets `expiresAt = now()` (soft delete) so the topic drops
// out of the active-topic list on the next read and any client's
// pruneExpiredTopics sweep. A `topic-deleted` wire fans out on the room
// channel so open sidebars remove the row instantly without waiting for
// the 15s sweep.
//
// Historical messages remain in the table but stop surfacing — the
// history endpoint already filters to #general + currently-active
// topic ids.

import { publish } from "@/lib/centrifugo";
import { prisma } from "@/lib/db";

import type { GroupTopicDeletedWire } from "../types";
import { groupChatErrorResponse, resolveGroupChatAccess } from "./access";

type Params = { slug: string; building: string; topicId: string };

export async function DELETE(_req: Request, ctx: { params: Promise<Params> }) {
  const { slug, building, topicId } = await ctx.params;
  const access = await resolveGroupChatAccess(slug, building);
  if ("error" in access) return groupChatErrorResponse(access.error);

  // Owner-only. Guests + non-owner signed-in visitors can't nuke topics
  // even ones they created themselves; keeping the rule simple ("only the
  // resident deletes") avoids a "creator can delete, others can't" UI.
  if (access.viewer.participantKey !== access.ownerParticipantKey) {
    return jsonError("not-owner", 403);
  }

  const topic = await prisma.groupTopic.findUnique({
    where: { id: topicId },
    select: { channelId: true, expiresAt: true },
  });
  if (!topic || topic.channelId !== access.channelId) {
    return jsonError("topic-not-found", 404);
  }

  const now = new Date();
  // Already expired? Still broadcast so any client that hasn't pruned
  // yet drops the row — no reason to 409 the owner.
  if (topic.expiresAt.getTime() > now.getTime()) {
    await prisma.groupTopic.update({
      where: { id: topicId },
      data: { expiresAt: now },
    });
  }

  const wire: GroupTopicDeletedWire = {
    type: "topic-deleted",
    channelId: access.channelId,
    topicId,
  };
  await publish(access.channelId, wire);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
