// Wire shapes shared between the group-chat server route, the
// Centrifugo channel, and the React overlay.
//
// Two publication types travel on the same room channel:
//
//   • { type: "message", ... } — a posted message, human or NPC. The
//     server publishes after persisting the row so refreshing reorders
//     against the same canonical id.
//   • { type: "typing", ... } — ephemeral "is typing" pulse. Receivers
//     show the speaker for TYPING_TTL_MS then drop them. Senders are
//     expected to re-publish every ~1s while still typing.

export const TYPING_TTL_MS = 3500;
/** Min interval between client-published typing pulses. Server-published
 *  NPC typing pulses use the same cadence while a stream is in flight. */
export const TYPING_THROTTLE_MS = 1200;
/** How far back the history endpoint goes — matches the conversation
 *  "retention" the user can rely on. Older rows still sit in the table
 *  (no sweeper for v1) but they never surface. */
export const HISTORY_WINDOW_MS = 60 * 60 * 1000;

export interface GroupMessageWire {
  type: "message";
  /** GroupMessage.id — stable, so refresh + live updates dedupe. */
  id: string;
  /** Centrifugo channel id (room name). Echoed for client sanity-check. */
  channelId: string;
  /** participantKey (user:<id> / guest:<id>) for humans, "npc:<npcId>" for NPCs. */
  authorKey: string;
  authorName: string;
  isNpc: boolean;
  text: string;
  /** ISO timestamp from the server. */
  createdAt: string;
}

export interface GroupTypingWire {
  type: "typing";
  channelId: string;
  authorKey: string;
  authorName: string;
  isNpc: boolean;
}

export type GroupChatWire = GroupMessageWire | GroupTypingWire;

/** Shape of a row returned by the history endpoint. */
export interface GroupMessageRow {
  id: string;
  channelId: string;
  authorKey: string;
  authorName: string;
  isNpc: boolean;
  text: string;
  createdAt: string;
}
