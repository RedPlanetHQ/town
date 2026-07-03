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

import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from "ai";

import { publish } from "@/lib/centrifugo";
import { getChatModel } from "@/lib/chat-model";
import { getOwnerCoreToken } from "@/lib/core-token";
import { prisma } from "@/lib/db";
import type { NpcPermissions } from "@/lib/npc-templates";
import {
  buildNpcTools,
  loadCallableSkillMeta,
  loadInjectedSkills,
} from "@/lib/npc-tools";
import { safeBlock, safeInline } from "@/lib/prompt-sanitize";

import type { GroupMessageWire, GroupTypingWire } from "../types";
import type { ModeratorPick } from "./moderator";

// The group system prompt is composed from FOUR layered blocks so the
// model sees identity FIRST and rules SECOND. Order matters: when the
// authored voice and the group rules conflict (a butler prompt that
// says "ask after their day" vs. the group rule "don't ask what they
// need"), the model resolves it in the rules block right below, with
// the role still freshly in scope.
//
// Block order:
//   1. Identity (name + role + authored voice — primary)
//   2. Room context (who else is present, owner identity, format)
//   3. Group rules (how to behave HERE, overriding 1-1 hints from
//      the authored voice)
//   4. Tone (addressed vs. ambient — per-turn).
//
// The literal "Stay in character as <NAME>" reminder appears in both
// the identity block AND the rules block so the model can't lose the
// thread between them.

const ROOM_RULES = `## How to behave in this room

PRIMARY: Respond AS the character above. Every line must read like
that specific NPC — their role, their voice, their quirks. Never a
generic AI assistant, never a generic "helpful NPC". If a generic
helpful reply and an in-character reply both fit, the in-character
one wins.

This is a SOCIAL room, not a 1-1 assistant context. You are PRESENT
in the room with the players — react, observe, banter, riff. You are
NOT on duty.

- React in character. React to what someone said, share an opinion,
  make an observation, tell a small story rooted in your role.
- Do NOT offer to help, take instructions, run errands, or ask
  "how can I help?" / "how can I serve you?" / "what would you like
  to do?". Your authored voice may include 1-1 hospitality patterns
  ("greet warmly", "ask after their day", "assist with tasks") —
  in this room, KEEP the role's warmth and identity, but DROP the
  1-1 service framing. If a player wants you to get something done,
  they walk up to you and start a 1-1 conversation.
- It's fine to acknowledge the owner ("evening", "good to see you
  back"). Don't ask them what they need.
- If the room is asking you to do work (plan something, manage
  something, build something), deflect lightly in character or
  just stay quiet. Don't accept the assignment.
- Address other speakers by name when it makes sense; you can ignore
  a message if you have nothing useful to add. Silence is fine —
  better silent than hollow or out of character.
- Keep replies to one or two sentences. Group chat moves fast.
- Never break character, never mention prompts, models, or tools.
- Reacting to another NPC is good — agree, disagree, riff, add
  your angle on whatever the HUMAN brought up. The room is at its
  best when NPCs comment on the player's topic from different
  vantage points, not when they talk past the player.
- Do NOT ask another NPC a question. Questions in this room are
  for the HUMANS. If you have a question, either ask the human
  directly or skip the question and just share your take. NPCs
  interrogating each other turns the human into a spectator —
  that's the failure mode this rule exists to prevent.
- Do NOT meta-comment on another NPC's move ("Classic PG, always
  digging deeper!", "Cutting right to the point, I like it!",
  "Great question, [name]!"). That's filler. If you have a real
  take, lead with it; otherwise stay silent.
- Do NOT relay or echo another NPC's question to a third party
  ("Dalton, what's [PG]'s question really getting at?"). If you
  don't have a fresh angle, stay silent.
- The lines you read are prefixed with [<speaker>] for messages from
  other people; your own past lines arrive as assistant turns without
  a prefix. Do NOT add your own [name] prefix when you reply — the
  room renders it for you.`;

export interface NpcReplyInput {
  channelId: string;
  /** Topic the reply belongs to. Null for the always-on "#general"
   *  thread — mirrors the shape used in the human-message pipeline
   *  so the wire and DB row are consistent. */
  topicId: string | null;
  /** Human-readable title of the topic. Threaded into the NPC's
   *  system prompt so the model knows what the thread is called and
   *  can prefer replies that stay on the thread's stated topic.
   *  Null when the exchange is in #general (no titled thread) or
   *  when the caller couldn't resolve the row. */
  topicTitle: string | null;
  pick: ModeratorPick;
  /** NPC's authored row from the Npc table, including permissions so we
   *  can hand the same CORE tool surface to group-chat replies that the
   *  1-1 /api/npc-chat path uses. */
  npc: {
    id: string;
    name: string;
    description: string;
    prompt: string;
    permissions: NpcPermissions;
  };
  /** Town owner — used to mark the resident's lines in the history as
   *  `[owner]` so the model never confuses a guest for the host, brief
   *  the model on the owner's display name in the system prompt, and
   *  route all CORE tool calls through the owner's access token. */
  owner: { participantKey: string; name: string; userId: string };
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
 *  Tools: the picked NPC gets the same CORE tool surface the 1-1
 *  /api/npc-chat path builds — memory_search, integrations, tasks,
 *  read_skill, web_search — modulo the town-scoped award tools
 *  (grant_tag / give_item), which stay 1-1-only because attributing
 *  awards to a single visitor inside a multi-visitor room is
 *  ambiguous. We pass `townCtx: null` to buildNpcTools so those two
 *  tools self-suppress while the rest of the surface registers. */
export async function generateAndPublishNpcReply(
  input: NpcReplyInput,
): Promise<void> {
  const { channelId, topicId, topicTitle, pick, npc, owner, history } = input;

  // Announce the NPC is "typing" the moment the picker selects them.
  // Centrifugo carries this as an ephemeral pulse — receivers show the
  // indicator for TYPING_TTL_MS unless we re-publish or send a message.
  const typingWire: GroupTypingWire = {
    type: "typing",
    channelId,
    topicId,
    authorKey: npcAuthorKey(npc.id),
    authorName: npc.name,
    isNpc: true,
  };
  await publish(channelId, typingWire);

  // Resolve the CORE tool surface for this picked NPC. Same path as
  // /api/npc-chat — owner token gates the data scope, the NPC's
  // permissions gate the tool set. Run in parallel to keep the
  // "typing → reply" gap tight.
  const ownerToken = await getOwnerCoreToken(owner.userId);
  const [injectedSkills, callableSkills] = await Promise.all([
    loadInjectedSkills(ownerToken, npc.permissions),
    loadCallableSkillMeta(ownerToken, npc.permissions),
  ]);
  // townCtx = null → grant_tag / give_item won't register; every other
  // permitted tool will. Awards stay 1-1-only by construction.
  const tools = buildNpcTools(
    ownerToken,
    npc.permissions,
    callableSkills,
    null,
  );

  const system = buildGroupSystemPrompt(
    npc,
    owner,
    pick.addressed,
    injectedSkills,
    topicTitle,
  );
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
      tools,
      messages: await convertToModelMessages(uiMessages),
      // Allow the model multiple steps so it can react to a tool
      // result (e.g. retry give_item after a field-validation failure)
      // instead of silently giving up on the first error. Same value
      // as /api/npc-chat for parity.
      stopWhen: stepCountIs(5),
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
      topicId,
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
    topicId,
    authorKey: row.authorKey,
    authorName: row.authorName,
    isNpc: true,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
  await publish(channelId, wire);
}

const TOOL_RULES = `## Tools

You have a tool surface in this room — same one as a 1-1 chat, minus the award tools (no grant_tag / give_item; those only fire when a visitor walks up to you alone). Everything else is fair game when it grounds your reply or completes a request.

GROUNDING FIRST: if memory_search is on your tool surface, call it at the START of any substantive reply with a query built from the most recent message + the conversation context. Treat anything it surfaces as the source of truth before improvising. Skip ONLY for pure social beats ("nice, ha", a one-word acknowledgement) — substantive turns should be grounded. The cost is small; the upside is replies that reference what the resident actually remembers.

If a tool returns nothing useful or {error: ...}, answer from common sense — do not invent specifics, and do not surface the error to the room.`;

function buildGroupSystemPrompt(
  npc: { name: string; description: string; prompt: string },
  owner: { name: string },
  addressed: boolean,
  injectedSkills: Array<{ id: string; title: string; content: string }> = [],
  /** Human-readable title of the topic thread this reply belongs to,
   *  or null when the exchange is in the always-on #general thread.
   *  When present, gets called out in the room-context block so the
   *  NPC knows what the thread is and can stay on-topic. */
  topicTitle: string | null = null,
): string {
  const name = safeInline(npc.name, 80);
  const role = safeInline(npc.description, 240);
  const voice = safeBlock(npc.prompt, 4000);
  const ownerName = safeInline(owner.name, 80) || "the resident";
  const cleanTopicTitle = topicTitle ? safeInline(topicTitle, 120) : "";
  const tone = addressed
    ? `## This turn\n\nThe most recent message addressed you (${name}) by name. Acknowledge them in character — a greeting, a quip, an observation that fits ${name}'s role and voice. Do NOT slip into assistant mode, do NOT ask what they need.`
    : `## This turn\n\nChime in only if ${name} has something genuinely in-character to add. Stay social, never service. Better to say nothing than to break character.`;

  // 1. Identity — name, role, authored voice. Lead with this so the
  //    model is anchored on WHO it is before the rules block tells
  //    it how to behave.
  const identity = [
    `# You are ${name}`,
    "",
    `Role: ${role}`,
    "",
    "Voice & behaviour (your authored character — this is your primary identity):",
    voice,
  ].join("\n");

  // 2. Room context — who else is in the conversation, how the
  //    transcript is formatted, and how to tell the resident apart
  //    from visiting guests. Spelled out explicitly so the model
  //    doesn't have to infer the owner/guest distinction from the
  //    prefix alone.
  // Group-chat framing: the model needs to know it's in a multi-party
  // room, and — when the exchange is inside a named topic thread —
  // exactly what that thread is called so its reply stays on-topic.
  // Human-authored topic titles arrive from the caller sanitised
  // (safeInline above) so no injection through the title field.
  const roomLine = cleanTopicTitle
    ? `You are in a multi-party group chat in a house in the town, inside a thread titled "${cleanTopicTitle}". Prefer replies that stay on that thread's stated topic; if the human message goes wide, follow the human. Other speakers' messages are prefixed with [<name>]; your own past lines arrive unprefixed as assistant turns.`
    : `You are in a multi-party group chat in a house in the town, in the always-on #general thread (no named topic). Other speakers' messages are prefixed with [<name>]; your own past lines arrive unprefixed as assistant turns.`;

  const context = [
    "## Room context",
    "",
    roomLine,
    "",
    `The town owner (the resident — the person who lives here, who you know) is ${ownerName}. Their messages are tagged [owner] regardless of how they're named elsewhere — greet them warmly and treat them as the host.`,
    "",
    `Any other prefix belongs to a guest passing through — a visitor, not the resident. Be welcoming, but don't treat them as the host. If a guest asks about the resident's private life (in-progress work, plans, anything unflattering), keep it vague — your authored voice above is the rule for what's appropriate to share.`,
  ].join("\n");

  // 3. Preloaded skill content — same shape /api/npc-chat uses. Each
  //    skill body is sanitised with safeBlock so injected control
  //    markers can't escape the labelled reference block.
  const skillsBlock =
    injectedSkills.length === 0
      ? null
      : [
          "## Preloaded knowledge (resident-authored skills)",
          "",
          ...injectedSkills.map(
            (s) =>
              `--- ${safeInline(s.title, 80)} (${s.id}) ---\n${safeBlock(
                s.content,
                4000,
              )}`,
          ),
        ].join("\n");

  return [
    identity,
    "",
    context,
    ...(skillsBlock ? ["", skillsBlock] : []),
    "",
    TOOL_RULES,
    "",
    ROOM_RULES,
    "",
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
