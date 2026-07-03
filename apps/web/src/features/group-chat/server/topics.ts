// GET  /api/group-chat/[slug]/[building]/topics
// POST /api/group-chat/[slug]/[building]/topics
//
// User-created ephemeral topics live alongside the always-on "#general"
// (represented client-side by activeTopicId=null). Every topic has a
// hard-clock 1h TTL; expired rows are filtered out at read time and
// don't count against caps.
//
// Caps are enforced at write time:
//   • MAX_TOPICS_PER_BUILDING active topics on the room channel
//   • MAX_TOPICS_PER_USER active topics owned by the creator on this
//     channel
//
// Guests can view, join, and post — but not create. Creation is
// signed-in-only so the "2 per user" cap has a stable subject key.

import { z } from "zod";

import { publish } from "@/lib/centrifugo";
import { prisma } from "@/lib/db";

import {
  MAX_TOPICS_PER_BUILDING,
  MAX_TOPICS_PER_USER,
  TOPIC_TITLE_MAX,
  TOPIC_TTL_MS,
  type GroupTopicCreatedWire,
  type GroupTopicRow,
} from "../types";
import {
  groupChatErrorResponse,
  resolveGroupChatAccess,
} from "./access";

type Params = { slug: string; building: string };

const CreateBodySchema = z.object({
  title: z.string().min(1).max(TOPIC_TITLE_MAX),
});

export async function GET(_req: Request, ctx: { params: Promise<Params> }) {
  const { slug, building } = await ctx.params;
  const access = await resolveGroupChatAccess(slug, building);
  if ("error" in access) return groupChatErrorResponse(access.error);

  const topics = await loadActiveTopics(access.channelId);
  return jsonOk({ topics });
}

export async function POST(req: Request, ctx: { params: Promise<Params> }) {
  const { slug, building } = await ctx.params;

  let body: z.infer<typeof CreateBodySchema>;
  try {
    body = CreateBodySchema.parse(await req.json());
  } catch (e) {
    return jsonError("bad-request", 400, (e as Error).message);
  }

  const access = await resolveGroupChatAccess(slug, building);
  if ("error" in access) return groupChatErrorResponse(access.error);

  // Guests can join topics but can't own them — the 2-per-user cap
  // needs a stable key. Guest keys rotate with their visitor cookie
  // so we'd be capping a phantom identity.
  if (!access.viewer.participantKey.startsWith("user:")) {
    return jsonError("sign-in-required", 403);
  }

  const title = body.title.trim();
  if (!title) return jsonError("empty-title", 400);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOPIC_TTL_MS);

  // Cap check runs first, insert second. There is a small race where
  // two concurrent creates from the same user could both slip past
  // the count read; the caps are guidance rather than hard invariants
  // (the sidebar just briefly shows 6/5 until the next refresh). Not
  // worth a serialisable transaction for v1.
  const [buildingActive, userActive] = await Promise.all([
    prisma.groupTopic.count({
      where: { channelId: access.channelId, expiresAt: { gt: now } },
    }),
    prisma.groupTopic.count({
      where: {
        channelId: access.channelId,
        createdByKey: access.viewer.participantKey,
        expiresAt: { gt: now },
      },
    }),
  ]);
  if (buildingActive >= MAX_TOPICS_PER_BUILDING) {
    return jsonError("too-many-topics", 409);
  }
  if (userActive >= MAX_TOPICS_PER_USER) {
    return jsonError("user-topic-limit", 409);
  }

  const row = await prisma.groupTopic.create({
    data: {
      channelId: access.channelId,
      townSlug: access.viewer.town.slug,
      buildingId: access.building.id,
      title,
      createdByKey: access.viewer.participantKey,
      createdByName: access.viewer.displayName,
      createdAt: now,
      expiresAt,
    },
  });

  const topic: GroupTopicRow = {
    id: row.id,
    title: row.title,
    createdByKey: row.createdByKey,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };

  const wire: GroupTopicCreatedWire = {
    type: "topic-created",
    channelId: access.channelId,
    topic,
  };
  await publish(access.channelId, wire);

  return jsonOk({ topic });
}

/** Active (unexpired) topics for one channel. Newest first so the
 *  sidebar renders the freshest ones at the top under #general. */
export async function loadActiveTopics(
  channelId: string,
): Promise<GroupTopicRow[]> {
  const rows = await prisma.groupTopic.findMany({
    where: { channelId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdByKey: r.createdByKey,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

function jsonOk(body: object): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(
  code: string,
  status: number,
  detail?: string,
): Response {
  return new Response(
    JSON.stringify(detail ? { error: code, detail } : { error: code }),
    { status, headers: { "content-type": "application/json" } },
  );
}
