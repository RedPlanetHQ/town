// Decides whether an NPC should chime into the room after a human
// message, and which one. No LLM call here — picker is deterministic so
// the cost story is "one LLM call per NPC reply, zero per message that
// nobody answers."
//
// Three gates, applied in order:
//   1. Room cooldown — at most one NPC speak per ROOM_COOLDOWN_MS so
//      the room can't turn into a wall of bot text.
//   2. Per-NPC cooldown — same NPC can't speak twice within
//      NPC_COOLDOWN_MS even across different prompts.
//   3. Mention detection — if the message text contains an NPC's name
//      (case-insensitive, word-boundary), that NPC wins immediately
//      regardless of probability.
//
// If no mention, we roll a die (REPLY_CHANCE) and on success pick the
// NPC who's been quietest the longest. That gives the room a steady
// background chatter without forcing every message to summon a reply.
//
// State is in-process Maps — fine for single-container dev. If we ever
// scale beyond one server we need Redis or Centrifugo presence-based
// state; the call-sites only touch these helpers so the swap is local.

const ROOM_COOLDOWN_MS = 8_000;
const NPC_COOLDOWN_MS = 20_000;
const REPLY_CHANCE = 0.3;

// channelId → last NPC speak timestamp (ms).
const roomLastSpeak = new Map<string, number>();
// `${channelId}:${npcId}` → last speak timestamp (ms).
const npcLastSpeak = new Map<string, number>();

export interface NpcCandidate {
  id: string;
  name: string;
}

export interface ModeratorPick {
  npc: NpcCandidate;
  /** True when the picker selected this NPC because the human
   *  message addressed them by name. Stage 2 uses this to instruct
   *  the model that it's been called on directly. */
  addressed: boolean;
}

export function pickResponder(
  channelId: string,
  message: string,
  npcs: NpcCandidate[],
): ModeratorPick | null {
  if (npcs.length === 0) return null;
  const now = Date.now();

  const lastRoom = roomLastSpeak.get(channelId) ?? 0;
  if (now - lastRoom < ROOM_COOLDOWN_MS) return null;

  // Pool of NPCs that aren't in per-NPC cooldown.
  const available: NpcCandidate[] = npcs.filter(
    (n) =>
      now - (npcLastSpeak.get(npcKey(channelId, n.id)) ?? 0) >=
      NPC_COOLDOWN_MS,
  );
  if (available.length === 0) return null;

  const mentioned = findMentionedNpc(message, available);
  if (mentioned) return { npc: mentioned, addressed: true };

  if (Math.random() >= REPLY_CHANCE) return null;

  // Pick whoever's been quietest the longest — gives variety in
  // ambient rooms instead of the same NPC dominating.
  let best = available[0]!;
  let bestQuiet = quietMsFor(channelId, best.id, now);
  for (let i = 1; i < available.length; i++) {
    const cand = available[i]!;
    const q = quietMsFor(channelId, cand.id, now);
    if (q > bestQuiet) {
      best = cand;
      bestQuiet = q;
    }
  }
  return { npc: best, addressed: false };
}

/** Stage 2 calls this immediately after the NPC's reply lands so future
 *  pick rolls see the fresh cooldown floors. */
export function markSpoke(channelId: string, npcId: string): void {
  const now = Date.now();
  roomLastSpeak.set(channelId, now);
  npcLastSpeak.set(npcKey(channelId, npcId), now);
}

function npcKey(channelId: string, npcId: string): string {
  return `${channelId}:${npcId}`;
}

function quietMsFor(channelId: string, npcId: string, now: number): number {
  const last = npcLastSpeak.get(npcKey(channelId, npcId)) ?? 0;
  return now - last;
}

function findMentionedNpc(
  text: string,
  candidates: NpcCandidate[],
): NpcCandidate | null {
  const lower = text.toLowerCase();
  for (const n of candidates) {
    // Word-boundary so "hudson" matches but "thudson" doesn't.
    const name = n.name.toLowerCase();
    if (!name) continue;
    const re = new RegExp(
      `\\b${escapeRegex(name)}\\b`,
      "i",
    );
    if (re.test(lower)) return n;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
