// POST /api/group-chat/[slug]/[building]
//
// One handler covers every human action in the room:
//
//   { kind: "message", text }  → persist + broadcast + maybe trigger NPC
//   { kind: "typing" }         → ephemeral typing pulse, no persistence
//
// We collapse these into one route so the client only opens one URL
// per house. Typing pulses are throttled client-side; the server just
// republishes them onto the room channel.

import { z } from "zod";

import { publish } from "@/lib/centrifugo";
import { prisma } from "@/lib/db";
import { ensureNpcsForUser } from "@/lib/plot";

import type {
  GroupMessageWire,
  GroupTypingWire,
} from "../types";
import {
  groupChatErrorResponse,
  resolveGroupChatAccess,
  type GroupChatAccess,
} from "./access";
import { markSpoke, pickResponder, type NpcCandidate } from "./moderator";
import { generateAndPublishNpcReply } from "./npc-reply";

type Params = { slug: string; building: string };

const BodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), text: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal("typing") }),
]);

export async function POST(req: Request, ctx: { params: Promise<Params> }) {
  const { slug, building } = await ctx.params;

  let body;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "bad-request", detail: (e as Error).message }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const access = await resolveGroupChatAccess(slug, building);
  if ("error" in access) return groupChatErrorResponse(access.error);

  if (body.kind === "typing") {
    const wire: GroupTypingWire = {
      type: "typing",
      channelId: access.channelId,
      authorKey: access.viewer.participantKey,
      authorName: access.viewer.displayName,
      isNpc: false,
    };
    await publish(access.channelId, wire);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // kind === "message" — persist, broadcast, then run the moderator.
  const text = body.text.trim();
  if (!text) {
    return new Response(JSON.stringify({ error: "empty" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const row = await prisma.groupMessage.create({
    data: {
      channelId: access.channelId,
      authorKey: access.viewer.participantKey,
      authorName: access.viewer.displayName,
      isNpc: false,
      text,
    },
  });

  const wire: GroupMessageWire = {
    type: "message",
    id: row.id,
    channelId: access.channelId,
    authorKey: row.authorKey,
    authorName: row.authorName,
    isNpc: false,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
  await publish(access.channelId, wire);

  // Fire-and-forget the NPC reply. We don't block the HTTP response on
  // it — the poster's send returns instantly, the NPC's reply (if any)
  // arrives over Centrifugo a few seconds later.
  void maybeTriggerNpcReply(access, text).catch((e) => {
    console.warn("[group-chat] NPC reply pipeline failed", e);
  });

  return new Response(JSON.stringify({ ok: true, id: row.id }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function maybeTriggerNpcReply(
  access: GroupChatAccess,
  triggeringText: string,
): Promise<void> {
  // Load the NPCs in this house. Auto-seed if the user's plot predates
  // the Npc table (same heal path /api/npc-chat uses).
  let npcs = await loadNpcsForBuilding(access);
  if (npcs.length === 0) {
    await ensureNpcsForUser(access.viewer.town.ownerId);
    npcs = await loadNpcsForBuilding(access);
  }
  if (npcs.length === 0) return;

  const candidates: NpcCandidate[] = npcs.map((n) => ({
    id: n.id,
    name: n.name,
  }));

  const pick = pickResponder(access.channelId, triggeringText, candidates);
  if (!pick) return;

  const picked = npcs.find((n) => n.id === pick.npc.id);
  if (!picked) return;

  // Stamp the cooldown floors *before* the stream runs so a model
  // failure can't leak the picker back into an immediate retry on
  // the next message. We accept that a stamped+failed reply burns
  // the slot until the cooldown elapses.
  markSpoke(access.channelId, picked.id);

  // Pull recent history for context. We fetch the same cap that
  // npc-reply applies (HISTORY_TURNS_MAX = 20) — npc-reply still
  // does its own tail slice as a guard so if these two ever drift,
  // the model still gets a bounded prompt rather than crashing.
  const recent = await prisma.groupMessage.findMany({
    where: { channelId: access.channelId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  recent.reverse();

  await generateAndPublishNpcReply({
    channelId: access.channelId,
    pick,
    npc: {
      id: picked.id,
      name: picked.name,
      description: picked.description,
      prompt: picked.prompt,
    },
    history: recent.map((r) => ({
      authorKey: r.authorKey,
      authorName: r.authorName,
      text: r.text,
      isNpc: r.isNpc,
    })),
  });
}

async function loadNpcsForBuilding(access: GroupChatAccess) {
  return prisma.npc.findMany({
    where: {
      userId: access.viewer.town.ownerId,
      buildingId: access.building.id,
    },
  });
}
