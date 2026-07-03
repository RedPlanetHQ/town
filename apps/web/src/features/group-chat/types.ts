// Wire shapes shared between the group-chat server route, the
// Centrifugo channel, and the React overlay.
//
// Three publication types travel on the same room channel:
//
//   • { type: "message", ... } — a posted message, human or NPC. The
//     server publishes after persisting the row so refreshing reorders
//     against the same canonical id.
//   • { type: "typing", ... } — ephemeral "is typing" pulse. Receivers
//     show the speaker for TYPING_TTL_MS then drop them. Senders are
//     expected to re-publish every ~1s while still typing.
//   • { type: "topic-created", ... } — new user-created topic. Every
//     open sidebar picks it up live without polling.
//
// `topicId` is null for the always-on "#general" thread and points at
// a GroupTopic row when the message lives inside a user-created topic.

export const TYPING_TTL_MS = 3500;
/** Min interval between client-published typing pulses. Server-published
 *  NPC typing pulses use the same cadence while a stream is in flight. */
export const TYPING_THROTTLE_MS = 1200;
/** How far back the history endpoint goes — matches the conversation
 *  "retention" the user can rely on. Older rows still sit in the table
 *  (no sweeper for v1) but they never surface. */
export const HISTORY_WINDOW_MS = 60 * 60 * 1000;

/** Hard clock: a user-created topic is alive for exactly this long
 *  from its createdAt. Matches HISTORY_WINDOW_MS so an expired topic's
 *  messages also fall out of the backfill in the same beat. */
export const TOPIC_TTL_MS = 60 * 60 * 1000;

/** Cap on concurrently-active (unexpired) user topics per building. */
export const MAX_TOPICS_PER_BUILDING = 5;

/** Cap on concurrently-active (unexpired) topics a single user can
 *  have open per building. Expired topics free the slot immediately. */
export const MAX_TOPICS_PER_USER = 2;

/** Cap on topic titles — long enough for a real thread name, short
 *  enough that the sidebar rows stay legible. */
export const TOPIC_TITLE_MAX = 60;

export interface GroupMessageWire {
  type: "message";
  /** GroupMessage.id — stable, so refresh + live updates dedupe. */
  id: string;
  /** Centrifugo channel id (room name). Echoed for client sanity-check. */
  channelId: string;
  /** GroupTopic.id when posted inside a topic; null for #general. */
  topicId: string | null;
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
  /** Topic the typing pulse is scoped to; null for #general. */
  topicId: string | null;
  authorKey: string;
  authorName: string;
  isNpc: boolean;
}

export interface GroupTopicCreatedWire {
  type: "topic-created";
  channelId: string;
  topic: GroupTopicRow;
}

export type GroupChatWire =
  | GroupMessageWire
  | GroupTypingWire
  | GroupTopicCreatedWire;

/** Shape of a message row returned by the history endpoint. */
export interface GroupMessageRow {
  id: string;
  channelId: string;
  topicId: string | null;
  authorKey: string;
  authorName: string;
  isNpc: boolean;
  text: string;
  createdAt: string;
}

/** Shape of a topic row returned by the history + topics endpoints. */
export interface GroupTopicRow {
  id: string;
  title: string;
  createdByKey: string;
  createdByName: string;
  createdAt: string;
  expiresAt: string;
}
