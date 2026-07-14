// Decides whether an NPC should chime into the room after a human
// message, and which one. One small `generateObject` call per non-
// cooled-down message; the model reads the recent conversation and
// either picks an NPC by id or returns null (silence).
//
// We deliberately don't try to do the picking with regex heuristics
// any more — "tell me another joke" should re-engage the joke teller
// without us maintaining a phrase list, and the LLM handles that
// naturally. Cost is bounded:
//
//   • Hard ROOM_COOLDOWN_MS gate runs first — if any NPC spoke
//     within the cooldown window we skip the call entirely. That
//     filters out the common "humans firing off messages back to
//     back" case before we burn tokens.
//   • generateObject with a tiny schema returns ~10 output tokens
//     per call. Input is bounded by HISTORY_TURNS_MAX of the recent
//     messages we already had to fetch for stage 2 anyway.
//
// State is in-process: just one Map keyed by (channelId, topicId)
// tracking the last NPC-speak timestamp. Same single-container caveat
// as before; move to Redis if the server ever scales horizontally.

import { generateObject } from "ai";
import { z } from "zod";

import { getChatModel } from "@/lib/chat-model";
import {
  modelIdOf,
  recordTokenUsage,
  tokensFrom,
} from "@/lib/token-usage";

const ROOM_COOLDOWN_MS = 8_000;

// `${channelId}::${topicId ?? "general"}` → last NPC speak timestamp
// (ms). Scoped per-topic so a chatty thread doesn't gag a quiet one
// inside the same building.
const roomLastSpeak = new Map<string, number>();

/** Compose the cooldown-map key from a channel + topic. Callers
 *  (route.ts / npc-reply.ts) pass the resulting key to pickResponder
 *  and markSpoke so the cooldown scope stays consistent. */
export function topicKey(
  channelId: string,
  topicId: string | null,
): string {
  return `${channelId}::${topicId ?? "general"}`;
}

export interface NpcCandidate {
  id: string;
  name: string;
  /** One-line role description (the `Npc.description` field). Helps
   *  the moderator decide which NPC fits the current topic. */
  description: string;
}

export interface ModeratorPick {
  npc: NpcCandidate;
  /** True when the model judged that the most recent message was
   *  addressed to this NPC (vs. an ambient drop-in). Stage 2 uses
   *  it to tighten the reply prompt. */
  addressed: boolean;
}

/** A single row in the recent-history slice we feed the moderator.
 *  Same shape stage 2 sees, so the route handler can pass the same
 *  slice to both. */
export interface HistoryRow {
  authorKey: string;
  authorName: string;
  text: string;
  isNpc: boolean;
}

// Both fields are REQUIRED. OpenAI's strict JSON-schema mode (which
// the AI SDK uses for generateObject) rejects optional properties —
// every key in `properties` has to be in `required`. So we keep
// `addressed` required and just have the model send `false` when it
// picks silence (npcId === null). Same effect, no schema fight.
const PickSchema = z.object({
  /** NPC id to respond, or null when nobody should speak. */
  npcId: z
    .string()
    .nullable()
    .describe(
      "id of the NPC who should reply, or null when silence is best",
    ),
  /** Did the latest message address this NPC directly (by name,
   *  follow-up, etc.)? Used to bias the reply tone. Send false when
   *  npcId is null. */
  addressed: z
    .boolean()
    .describe(
      "true if the latest message clearly addressed the picked NPC; false otherwise (including when npcId is null)",
    ),
});

const SYSTEM_PROMPT = `You moderate turn-taking in a small multi-party room chat.
Players (humans) and a handful of in-character NPCs share the room.

This is a SOCIAL room, not a task surface. NPCs don't take direction
here — if a human wants real work done they walk over and start a
1-1 chat. Your job is to keep the room feeling alive without turning
it into an assistant queue.

Pick AT MOST ONE NPC to reply to the latest message, or return
npcId: null for silence. Default to silence — it's much better to
stay quiet than to chime in with something hollow.

# Self-reply is FORBIDDEN

The latest message in the conversation has an author. If that
author is an NPC (their prefix has "(npc)"), THAT SAME NPC MUST NOT
BE PICKED. Either pick a DIFFERENT NPC or return null. This is the
single hardest rule in this prompt — violating it produces an NPC
talking to itself, which is always wrong.

The continuation rule below (same NPC replies to follow-ups like
"tell me another") ONLY applies when the follow-up is from a HUMAN.

# NPC-to-NPC chimes

The latest message may be from a HUMAN or another NPC. Picking an
NPC to respond to a DIFFERENT NPC is allowed — and good — when the
second NPC has something genuinely additive on the topic THE HUMAN
raised: a riff, a counterpoint, an observation from a different
angle, a brief story rooted in their role. That's how the room
gets real multi-party feel.

What's NOT okay, and is what kills the room:
- One NPC asking ANOTHER NPC a question, treating them like a
  participant being interviewed. NPCs don't interrogate each other —
  questions in this room are directed at HUMANS, or they're
  rhetorical. If the previous NPC asked a direct question of
  another NPC, return silence (or pick the targeted NPC for a
  short deflection only if the role makes it natural).
- Meta-comments on another NPC's move ("Classic PG, always digging
  deeper!", "Cutting right to the point, I like it!", "Great
  question, [name]!"). Pure filler. Don't extend it.
- Repeating / relaying the previous NPC's question to a third
  party. If the previous NPC already asked it, picking another NPC
  to ask the same thing again is always wrong.
- Two NPCs trading questions back at each other with no human
  contribution between them — the human is now a spectator. Stop.

Default to silence when:
- More than ONE NPC has already replied since the last human turn —
  the chain has run its course, let the humans speak.
- The previous NPC just asked the human a question and the human
  hasn't answered yet. Piling on with a second NPC question in the
  same beat makes the human feel interrogated — let them reply first.
- The topic has drifted off whatever the human actually raised.
- The room has nothing fresh to add and is starting to spin in
  place.

Pick rules:
- If the latest message names an NPC, that NPC may reply with a
  short in-character acknowledgement (a greeting, a quip, a
  reaction). They should NOT take instructions or offer to help.
- If it's a clear conversational follow-up to an NPC's previous
  turn ("tell me another", "more please", "what about X"), the
  same NPC should reply.
- If it's a quick light question that an NPC's role makes them
  the natural answerer ("what's good to read?", "is anyone here?"),
  that NPC may reply briefly.
- If another NPC just said something a different NPC has a clear,
  in-character reaction to (and it would feel natural in a real
  room), that other NPC may chime in once.
- Otherwise: silence.

Strongly prefer silence (npcId: null) when:
- Humans are clearly talking to each other.
- The message is trivial chit-chat ("ok", "lol", "namaste").
- The human is giving an instruction, planning work, or asking an
  NPC to manage / build / coordinate something — that belongs in
  a 1-1 chat, not the room.
- The latest few turns have already been NPCs talking to NPCs and
  there's nothing fresh to add — let the humans speak.

Set addressed: true when the latest message is plainly aimed at the
picked NPC; false when they're chiming in ambiently.

Never pick an NPC who isn't in the supplied list. Never invent ids.`;

export interface PickOptions {
  /** Skip the room cooldown check. Used when we're mid-chain
   *  (NPC just spoke, we want to consider whether another NPC
   *  has something to add). The 8s floor exists to throttle
   *  replies to *human* spam — inside a chain it would block the
   *  conversation entirely. */
  skipRoomCooldown?: boolean;
  /** When present, the LLM branch logs a "decision" TokenUsage row +
   *  debits aura. Omitted for callers that don't run inside a town
   *  context (test-moderator.ts). The deterministic direct-address
   *  branch spends no tokens so it never logs, even when this is set. */
  usageContext?: {
    townId: string;
    userId: string;
    buildingId: string;
    topicId?: string | null;
  };
}

export async function pickResponder(
  cooldownKey: string,
  history: HistoryRow[],
  npcs: NpcCandidate[],
  options: PickOptions = {},
): Promise<ModeratorPick | null> {
  if (npcs.length === 0) return null;
  if (history.length === 0) return null;

  const lastRow = history[history.length - 1];

  // Deterministic direct-address override. If the latest message is
  // from a human and names one of the NPCs by word-boundary match,
  // that NPC wins — no LLM call, no cooldown gate. The moderator
  // prompt's "if the latest message names an NPC, that NPC may reply"
  // rule is soft and small chat models drop it under load, which is
  // how "hi dalton" ended up routed to PG. This short-circuit is the
  // one signal we should never let the model override.
  //
  // The `!lastRow.isNpc` gate is load-bearing: it prevents the
  // override from firing when the latest message is from an NPC, so
  // the self-reply guard further down still fully protects that case.
  // Don't drop the gate without adding an equivalent check here.
  if (lastRow && !lastRow.isNpc) {
    const addressed = findAddressedNpc(lastRow.text, npcs);
    if (addressed) return { npc: addressed, addressed: true };
  }

  if (!options.skipRoomCooldown) {
    const now = Date.now();
    const lastRoom = roomLastSpeak.get(cooldownKey) ?? 0;
    if (now - lastRoom < ROOM_COOLDOWN_MS) return null;
  }

  let model;
  try {
    model = getChatModel().model;
  } catch {
    // No LLM configured — silent fallback. The room still works as a
    // human-only chat.
    return null;
  }
  const modModelId = modelIdOf(model);

  const npcList = npcs
    .map((n) => `- id="${n.id}", name="${n.name}", role="${n.description}"`)
    .join("\n");
  const recent = history
    .map((r) => `[${r.isNpc ? `${r.authorName} (npc)` : r.authorName}] ${r.text}`)
    .join("\n");
  const userPrompt = [
    "NPCs in the room:",
    npcList,
    "",
    "Recent conversation (oldest → newest):",
    recent,
    "",
    "Pick at most one NPC id from the list above to reply to the",
    "latest message, or return null for silence.",
  ].join("\n");

  let pick;
  try {
    const result = await generateObject({
      model,
      schema: PickSchema,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
    });
    pick = result.object;
    if (options.usageContext) {
      const tokens = tokensFrom(result.usage);
      void recordTokenUsage({
        townId: options.usageContext.townId,
        userId: options.usageContext.userId,
        event: "decision",
        model: modModelId,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        buildingId: options.usageContext.buildingId,
        metadata: options.usageContext.topicId
          ? { topicId: options.usageContext.topicId }
          : undefined,
      });
    }
  } catch (e) {
    console.warn("[group-chat] moderator generateObject failed", e);
    return null;
  }

  if (!pick.npcId) return null;
  const picked = npcs.find((n) => n.id === pick.npcId);
  if (!picked) {
    // Model returned an id we didn't ship — treat as silence.
    console.warn(
      `[group-chat] moderator picked unknown npcId="${pick.npcId}"`,
    );
    return null;
  }

  // Hard guard against self-reply. The system prompt forbids it but
  // small models (4o-mini, Haiku) don't reliably obey on every turn,
  // so we enforce it here too — making the picker self-correcting
  // regardless of caller. An NPC replying to themselves is always
  // wrong, so silence is the correct fallback.
  const last = history[history.length - 1];
  if (last && last.isNpc && last.authorKey === `npc:${picked.id}`) {
    return null;
  }

  return { npc: picked, addressed: pick.addressed };
}

/** Stage 2 calls this immediately after the NPC's reply lands so
 *  future moderator calls see the fresh room cooldown floor. Stamps
 *  on pick (not after stream) keeps a failed stream from refiring
 *  the picker on the very next message. `cooldownKey` is the same
 *  composed key pickResponder saw — pass `topicKey(channelId, topicId)`. */
export function markSpoke(cooldownKey: string, _npcId: string): void {
  roomLastSpeak.set(cooldownKey, Date.now());
}

/** Word-boundary case-insensitive match on any candidate NPC's display
 *  name, tolerating first-name-only addressing. NPC display names in
 *  this codebase are typically full names ("Dalton Caldwell", "Garry
 *  Tan") but humans address them by first name ("hi dalton"). We
 *  build an alias list per NPC — the full name plus each token ≥ 3
 *  chars — then match longest alias first so "Dalton Caldwell" wins
 *  over "Dalton" if both would match, and multi-token full names beat
 *  single-token first names on tie. The ≥ 3 char floor prevents
 *  false-positive matches on tokens like "Al" or "Hu". Returns the
 *  first NPC whose alias matches, or null. */
function findAddressedNpc(
  text: string,
  npcs: NpcCandidate[],
): NpcCandidate | null {
  const aliases: Array<{ npc: NpcCandidate; alias: string }> = [];
  for (const n of npcs) {
    if (!n.name) continue;
    const seen = new Set<string>();
    const add = (a: string) => {
      const trimmed = a.trim();
      if (trimmed.length < 3) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      aliases.push({ npc: n, alias: trimmed });
    };
    add(n.name);
    for (const token of n.name.split(/\s+/)) add(token);
  }
  aliases.sort((a, b) => b.alias.length - a.alias.length);
  for (const { npc, alias } of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(text)) return npc;
  }
  return null;
}
