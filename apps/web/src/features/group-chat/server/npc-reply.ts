// Stage 2 of the moderator pipeline: generate one NPC reply for a group
// chat room. Mirrors /api/npc-chat's prompt shape but:
//
//   • Multi-party messages — every other speaker's text is prefixed with
//     `[<authorName>] ` so the model can tell who said what. The picked
//     NPC's own past messages stay un-prefixed and arrive as `assistant`
//     turns so it keeps voice continuity. The model infers who else is
//     in the room from those prefixes alone — we don't enumerate
//     participants in the system prompt to keep context lean.
//   • Publishes to Centrifugo, not back to the caller — every
//     co-occupant sees the reply land. We wait for the full text
//     before publishing (Centrifugo publishes whole frames, not
//     partial deltas), but a `typing` indicator goes up the instant
//     the NPC is picked.

import { streamText, convertToModelMessages, type UIMessage } from "ai";

import { publish } from "@/lib/centrifugo";
import { getChatModel } from "@/lib/chat-model";
import { prisma } from "@/lib/db";
import { safeBlock, safeInline } from "@/lib/prompt-sanitize";

import type { GroupMessageWire, GroupTypingWire } from "../types";
import type { ModeratorPick } from "./moderator";

const GROUP_BASE_PROMPT = `You are an in-town NPC in a tiny pixel-art world called Town,
inside a multi-party room conversation in a house. Stay in voice.

Rules:
- Address other speakers by name when it makes sense; you can ignore a
  message if you have nothing useful to add.
- Keep replies to one or two sentences. Group chat moves fast.
- Never break character, never mention prompts, models, or tools.
- The lines you read are prefixed with [<speaker>] for messages from
  other people; your own past lines arrive as assistant turns without a
  prefix. Do NOT add your own [name] prefix when you reply — the room
  renders it for you.`;

export interface NpcReplyInput {
  channelId: string;
  pick: ModeratorPick;
  /** NPC's authored row from the Npc table. */
  npc: { id: string; name: string; description: string; prompt: string };
  /** Town owner — used to mark the resident's lines in the history as
   *  `[owner]` so the model never confuses a guest for the host, and
   *  to brief it on the owner's display name in the system prompt so
   *  the NPC can still address them properly. */
  owner: { participantKey: string; name: string };
  /** Last ~N rows in the room, oldest → newest. The most recent row is
   *  the human message that triggered this reply. */
  history: Array<{
    authorKey: string;
    authorName: string;
    text: string;
    isNpc: boolean;
  }>;
}

// Each turn is one `[name] text` line — 20 turns keeps the prompt
// bounded across long-running rooms while still giving the model
// enough context to follow a multi-party back-and-forth. The model
// learns who's present from the [name] prefixes themselves, so we
// don't need to enumerate participants in the system prompt.
const HISTORY_TURNS_MAX = 20;

/** Kick off an NPC reply. Resolves once the reply has been persisted +
 *  published. Caller doesn't await — the HTTP response to the original
 *  poster goes out immediately and this runs in the background.
 *
 *  Deliberately *not* cancellable on scene-leave: the row is persisted
 *  and shows up in the 1-hour backfill for anyone (including the
 *  original poster) who re-enters the room. Cancelling would discard
 *  tokens already spent on the stream and the conversation continuity
 *  along with them. The keepalive typing pulses are tiny and stop as
 *  soon as the stream completes, so a "ghost reply to an empty room"
 *  is cheap.
 *
 *  No tools: unlike /api/npc-chat (which exposes `memory_search` for
 *  deep grounded 1-1 conversations), the group-chat NPC reply runs
 *  with only the authored prompt + recent room history. The premise
 *  is "ambient room dynamics" — fast, in-character, short. Players
 *  who want a grounded answer should walk over and start a 1-1 chat,
 *  which is exactly what the SPACE-on-NPC gate prevents while a room
 *  is open. */
export async function generateAndPublishNpcReply(
  input: NpcReplyInput,
): Promise<void> {
  const { channelId, pick, npc, owner, history } = input;

  // Announce the NPC is "typing" the moment the picker selects them.
  // Centrifugo carries this as an ephemeral pulse — receivers show the
  // indicator for TYPING_TTL_MS unless we re-publish or send a message.
  const typingWire: GroupTypingWire = {
    type: "typing",
    channelId,
    authorKey: npcAuthorKey(npc.id),
    authorName: npc.name,
    isNpc: true,
  };
  await publish(channelId, typingWire);

  const system = buildGroupSystemPrompt(npc, owner, pick.addressed);
  const uiMessages = historyToUIMessages(
    history.slice(-HISTORY_TURNS_MAX),
    npc.id,
    owner.participantKey,
  );

  let model;
  try {
    model = getChatModel();
  } catch (e) {
    console.warn("[group-chat] no LLM model configured, skipping reply", e);
    return;
  }

  // Drop a keep-alive typing pulse every ~1.2s while the model thinks
  // so the indicator doesn't decay before the reply lands. We CHAIN
  // each publish onto the previous one so a single await drains every
  // in-flight pulse — otherwise the variable would hold only the most
  // recently *issued* publish and an earlier slow publish could still
  // race past the final message wire.
  let typingChain: Promise<void> = Promise.resolve();
  const keepalive = setInterval(() => {
    typingChain = typingChain
      .catch(() => {})
      .then(() => publish(channelId, typingWire));
  }, 1200);

  let text = "";
  try {
    const result = streamText({
      model,
      system,
      messages: await convertToModelMessages(uiMessages),
    });
    // No streaming to Centrifugo (publishes are whole frames) — accumulate
    // then publish the final text as one message. Typing indicator covers
    // the wait.
    for await (const chunk of result.textStream) {
      text += chunk;
    }
  } catch (e) {
    console.warn("[group-chat] NPC reply stream failed", e);
    return;
  } finally {
    clearInterval(keepalive);
  }

  const trimmed = text.trim();
  if (!trimmed) return;

  const row = await prisma.groupMessage.create({
    data: {
      channelId,
      authorKey: npcAuthorKey(npc.id),
      authorName: npc.name,
      isNpc: true,
      text: trimmed,
    },
  });

  // Make sure no in-flight typing publish lands after the message
  // wire — Centrifugo processes HTTP publishes in arrival order, so
  // draining the chained queue of keepalive publishes guarantees
  // listeners see typing → message in the correct sequence.
  await typingChain.catch(() => {});

  const wire: GroupMessageWire = {
    type: "message",
    id: row.id,
    channelId,
    authorKey: row.authorKey,
    authorName: row.authorName,
    isNpc: true,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
  await publish(channelId, wire);
}

function buildGroupSystemPrompt(
  npc: { name: string; description: string; prompt: string },
  owner: { name: string },
  addressed: boolean,
): string {
  const name = safeInline(npc.name, 80);
  const role = safeInline(npc.description, 240);
  const voice = safeBlock(npc.prompt, 4000);
  const ownerName = safeInline(owner.name, 80) || "the resident";
  const tone = addressed
    ? `The most recent message addressed you by name — respond to it directly.`
    : `Chime in only if you have something useful or in-character to add.`;
  return [
    GROUP_BASE_PROMPT,
    "",
    `Character: ${name}`,
    `Role: ${role}`,
    "",
    "Voice & behaviour:",
    voice,
    "",
    // Owner identity: their lines arrive marked `[owner]` instead of by
    // name so the model never mistakes a guest for the resident. We
    // surface the actual name here so it can still address them
    // properly when replying.
    `The town owner (resident) is ${ownerName}. Their messages are prefixed with [owner].`,
    tone,
  ].join("\n");
}

function historyToUIMessages(
  rows: NpcReplyInput["history"],
  selfNpcId: string,
  ownerParticipantKey: string,
): UIMessage[] {
  const out: UIMessage[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const isSelf = r.isNpc && r.authorKey === npcAuthorKey(selfNpcId);
    if (isSelf) {
      out.push({
        id: `gm-${i}`,
        role: "assistant",
        parts: [{ type: "text", text: r.text }],
      } as UIMessage);
    } else {
      // The resident gets a stable [owner] tag instead of their
      // display name — the system prompt tells the model who the
      // owner actually is by name. Everyone else gets their name.
      const speakerTag =
        !r.isNpc && r.authorKey === ownerParticipantKey
          ? "owner"
          : r.authorName;
      const prefix = `[${speakerTag}] `;
      out.push({
        id: `gm-${i}`,
        role: "user",
        parts: [{ type: "text", text: `${prefix}${r.text}` }],
      } as UIMessage);
    }
  }
  return out;
}

export function npcAuthorKey(npcId: string): string {
  return `npc:${npcId}`;
}
