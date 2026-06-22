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
import { normalizePermissions } from "@/lib/npc-templates";
import { ensureNpcsForUser } from "@/lib/plot";
import { recordTownActivity } from "@/lib/town-activity";

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

  // Activity feed: emit "group chat started in <building>" only when
  // the room has been silent for the last hour — i.e. this human post
  // is opening a fresh session, not extending an active one. We check
  // BEFORE inserting so we don't see our own row. NPC replies count as
  // activity (they keep the room "live"), so a chatty NPC chain bridges
  // sessions and the next human post within the hour stays silent.
  const SESSION_WINDOW_MS = 60 * 60 * 1000;
  const prior = await prisma.groupMessage.findFirst({
    where: {
      channelId: access.channelId,
      createdAt: { gte: new Date(Date.now() - SESSION_WINDOW_MS) },
    },
    select: { id: true },
  });
  const isFreshSession = !prior;

  const row = await prisma.groupMessage.create({
    data: {
      channelId: access.channelId,
      authorKey: access.viewer.participantKey,
      authorName: access.viewer.displayName,
      isNpc: false,
      text,
    },
  });

  if (isFreshSession) {
    void recordTownActivity({
      townSlug: access.viewer.town.slug,
      kind: "group_chat_started",
      subjectKey: access.viewer.participantKey,
      subjectName: access.viewer.displayName,
      subjectCharacter: access.viewer.character,
      metadata: {
        buildingId: access.building.id,
        buildingLabel: access.building.label ?? access.building.id,
      },
    }).catch((e) =>
      console.warn("[town-activity] group_chat_started failed", e),
    );
  }

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
  void maybeTriggerNpcReply(access).catch((e) => {
    console.warn("[group-chat] NPC reply pipeline failed", e);
  });

  return new Response(JSON.stringify({ ok: true, id: row.id }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Hard cap on the number of NPC turns that can land between two
// human messages. Even if the moderator keeps picking, we bail at
// this count so a runaway "NPCs chatting to each other forever"
// scenario can't happen. Kept low: one direct reply to the human +
// at most one NPC-on-NPC riff. Anything past that reads as filler
// (we shipped with 20 and observed rooms looping at each other for
// 10+ turns asking each other rhetorical questions — silence is much
// better than that).
const MAX_NPC_CHAIN_TURNS = 2;

// Human stop-signals that abort the chain mid-flight. We re-fetch
// history every loop iteration so a "stop / enough / shut up" posted
// while NPCs were mid-stream gets noticed before the next pick. Kept
// deliberately small + colloquial — broad enough to catch real
// frustration ("oh god stop it", "guys enough"), narrow enough to
// avoid false positives on the word appearing inside an actual
// question.
const STOP_SIGNAL = /\b(?:stop|stoppp+|enough|quiet|shut\s*up|chill|please\s+stop|shush)\b/i;

function isStopRequest(text: string): boolean {
  return STOP_SIGNAL.test(text);
}

async function maybeTriggerNpcReply(access: GroupChatAccess): Promise<void> {
  // Load the NPCs in this house ONCE. Auto-seed if the user's plot
  // predates the Npc table (same heal path /api/npc-chat uses).
  let npcs = await loadNpcsForBuilding(access);
  if (npcs.length === 0) {
    await ensureNpcsForUser(access.viewer.town.ownerId);
    npcs = await loadNpcsForBuilding(access);
  }
  if (npcs.length === 0) return;

  const candidates: NpcCandidate[] = npcs.map((n) => ({
    id: n.id,
    name: n.name,
    description: n.description,
  }));
  const npcById = new Map(npcs.map((n) => [n.id, n]));

  // Chain loop — first iteration is the standard "human said something,
  // does any NPC reply?" check. Subsequent iterations are "an NPC just
  // replied, does another NPC have something to add?" The loop ends
  // when the moderator picks silence, the hard cap is hit, or a fetch
  // fails.
  //
  // We refetch history each iteration so it includes whatever the
  // previous iteration just published — moderator decisions stay
  // grounded in the latest state.
  for (let turn = 0; turn < MAX_NPC_CHAIN_TURNS; turn++) {
    const isChain = turn > 0;

    const recent = await prisma.groupMessage.findMany({
      where: { channelId: access.channelId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    recent.reverse();
    const history = recent.map((r) => ({
      authorKey: r.authorKey,
      authorName: r.authorName,
      text: r.text,
      isNpc: r.isNpc,
    }));

    // Robust hard stop: count NPC messages since the most recent
    // human message in the history. This guards against concurrent
    // chains (another human message could have triggered a second
    // maybeTriggerNpcReply call in parallel) by anchoring on the
    // actual conversation state, not just our local loop counter.
    if (consecutiveNpcTurnsAtEnd(history) >= MAX_NPC_CHAIN_TURNS) return;

    // Human stop-signal short-circuit. If ANY of the recent human
    // messages since the last NPC turn says "stop / enough / shut
    // up", drop the chain immediately — even mid-flight. The owner
    // is right that ignoring "oh god stop it" is the worst possible
    // failure mode for this loop.
    if (recentHumanRequestedStop(history)) return;

    const pick = await pickResponder(
      access.channelId,
      history,
      candidates,
      // Chain calls bypass the 8s room cooldown — that floor exists
      // to throttle replies to human spam, not to space out turns
      // inside an active NPC-to-NPC exchange.
      { skipRoomCooldown: isChain },
    );
    if (!pick) return;

    // Hard guard against the same NPC replying to themselves. The
    // moderator prompt forbids this too but we belt-and-braces it
    // here so a single bad pick can't turn into "Sol responds to
    // Sol responds to Sol". End the chain instead.
    const last = history[history.length - 1];
    if (last && last.isNpc && last.authorKey === `npc:${pick.npc.id}`) {
      return;
    }

    const picked = npcById.get(pick.npc.id);
    if (!picked) return;

    // Stamp the room cooldown ONLY on the first reply per human
    // turn. Stamping on every chain turn would leave a stale 8s
    // cooldown after the chain ends, blocking the NEXT human's
    // message. Stamping just once means the cooldown is fresh
    // relative to the human-triggering event, which is what it's
    // meant to throttle.
    if (!isChain) markSpoke(access.channelId, picked.id);

    await generateAndPublishNpcReply({
      channelId: access.channelId,
      pick,
      npc: {
        id: picked.id,
        name: picked.name,
        description: picked.description,
        prompt: picked.prompt,
        // `permissions` arrives as a JSONB blob from Prisma — run it
        // through the same normaliser /api/town POST uses so an MDX
        // typo can't smuggle in an unknown key. `null` (no grant) is
        // normalised to an empty object inside, which buildNpcTools
        // treats as "no tools".
        permissions: normalizePermissions(picked.permissions),
      },
      owner: {
        participantKey: access.ownerParticipantKey,
        name: access.ownerName,
        userId: access.viewer.town.ownerId,
      },
      history,
    });
  }
}

/** Count NPC messages at the tail of the history, stopping at the
 *  first human message. "Turns since last human" — the invariant the
 *  chain cap actually cares about. */
function consecutiveNpcTurnsAtEnd(
  history: Array<{ isNpc: boolean }>,
): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.isNpc) n++;
    else break;
  }
  return n;
}

/** True if any HUMAN message inside the trailing NPC-then-human window
 *  matches STOP_SIGNAL. Scans newest-first and stops at the FIRST NPC
 *  message it sees so we only consider humans posted SINCE the last NPC
 *  turn (i.e. the humans who could be reacting to the in-flight chain).
 *  Returning true causes the chain loop to bail before the next pick. */
function recentHumanRequestedStop(
  history: Array<{ isNpc: boolean; text: string }>,
): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i]!;
    if (row.isNpc) break;
    if (isStopRequest(row.text)) return true;
  }
  return false;
}

async function loadNpcsForBuilding(access: GroupChatAccess) {
  return prisma.npc.findMany({
    where: {
      userId: access.viewer.town.ownerId,
      buildingId: access.building.id,
    },
  });
}
