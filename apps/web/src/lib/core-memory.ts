// Push NPC chat turns into the town owner's CORE memory graph via
// POST /api/v1/add. Memory always belongs to the OWNER — guests don't
// get their own memory, so the owner's access token is what authorises
// the call regardless of who is actually chatting.
//
// Episode body format (mirrors the speaker tag used in our LLM prompts
// so the same conventions show up everywhere memory_search returns):
//
//   • Owner is the speaker:
//       user: <message>
//       assistant <npc-name>: <reply>
//
//   • Guest is the speaker:
//       [<guest-name>]: <message>
//       assistant <npc-name>: <reply>
//
// Fire-and-forget: a failed ingest must never block or surface to the
// chat reply. All errors log and swallow.
//
// Companion to npc-tools.ts's memory_search — that tool READS the
// owner's memory; ingestNpcTurn WRITES new conversation episodes back
// into it after every NPC turn, so what the NPC said becomes part of
// the resident's recall going forward.

import { safeInline } from "./prompt-sanitize";

const CORE_BASE_ENV = "CORE_OAUTH_BASE";

// CORE rejects shorter episodes; skip rather than POST a body we know
// will 400.
const MIN_EPISODE_BODY = 20;

// One sessionId rolls over per 24h. CORE uses sessionId to (a) link
// episodes into one conversation for graph resolution
// (getSessionEpisodes), (b) flip the first-turn "memory.added" signal
// to "memory.updated" on subsequent turns, and (c) collapse the
// conversation into a single compacted Document row keyed
// (sessionId, workspaceId). A 24h bucket keeps turns inside one
// day-long chat with the same NPC tied together without needing any
// server-side state.
const DAY_MS = 24 * 60 * 60 * 1000;

/** Stable session id for "this user/guest talking with this NPC inside
 *  one 24h window". Same inputs + same UTC day → same id. Crosses to a
 *  new id at the next UTC day boundary. Caller passes `now` only in
 *  tests; production reads Date.now(). */
export function npcChatSessionId(
  npcId: string,
  subjectKey: string,
  now: number = Date.now(),
): string {
  const dayBucket = Math.floor(now / DAY_MS);
  return `town-npc:${npcId}:${subjectKey}:${dayBucket}`;
}

export interface IngestNpcTurnInput {
  /** Owner's CORE access token. null → owner hasn't linked CORE, skip. */
  ownerToken: string | null;
  /** NPC display name — interpolated into the assistant line. */
  npcName: string;
  /** Whether the speaker IS the town owner. Controls `user` vs `[guest]`. */
  isOwner: boolean;
  /** Guest's display name. Only consulted when isOwner === false. */
  speakerName: string;
  /** What the speaker said this turn. */
  speakerText: string;
  /** What the NPC replied this turn. */
  assistantText: string;
  /** Source tag — e.g. "town:npc-chat" or "town:group-chat". */
  source: string;
  /** Optional session id grouping turns inside one logical conversation. */
  sessionId?: string;
  /** Optional metadata bag — keys must be string/number/boolean per CORE. */
  metadata?: Record<string, string | number | boolean>;
  /** Optional CORE endUserId — the counterparty this episode is about.
   *  Callers pass the visitor's stable subjectKey for guest turns; leave
   *  undefined for owner turns (those aren't about anyone else). Stamped
   *  on the CORE episode so downstream searches can filter by visitor. */
  endUserId?: string;
}

/** Build the episode body for one chat turn. Exported so tests can pin
 *  the wire format; runtime callers go through ingestNpcTurn. */
export function formatNpcTurnBody(
  npcName: string,
  isOwner: boolean,
  speakerName: string,
  speakerText: string,
  assistantText: string,
): string {
  const cleanedNpc = safeInline(npcName, 80) || "the NPC";
  const speakerTag = isOwner
    ? "user"
    : `[${safeInline(speakerName, 80) || "guest"}]`;
  const speakerLine = `${speakerTag}: ${speakerText.trim()}`;
  const assistantLine = `assistant ${cleanedNpc}: ${assistantText.trim()}`;
  return `${speakerLine}\n${assistantLine}`;
}

/** Fire-and-forget memory ingest. Resolves (without throwing) regardless
 *  of network/HTTP outcome — chat replies must not wait on the graph. */
export async function ingestNpcTurn(opts: IngestNpcTurnInput): Promise<void> {
  if (!opts.ownerToken) return;
  if (!opts.speakerText.trim() || !opts.assistantText.trim()) return;

  const base = process.env[CORE_BASE_ENV];
  if (!base) return;

  const episodeBody = formatNpcTurnBody(
    opts.npcName,
    opts.isOwner,
    opts.speakerName,
    opts.speakerText,
    opts.assistantText,
  );
  if (episodeBody.length < MIN_EPISODE_BODY) return;

  try {
    const res = await fetch(`${base}/api/v1/add`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        episodeBody,
        referenceTime: new Date().toISOString(),
        source: opts.source,
        type: "CONVERSATION",
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
        ...(opts.endUserId ? { endUserId: opts.endUserId } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(
        "[core-memory] ingest failed",
        res.status,
        detail.slice(0, 300),
      );
    }
  } catch (e) {
    console.warn("[core-memory] ingest threw", e);
  }
}
