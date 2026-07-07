// Centrifugo subscription for one room channel + the wire client that
// talks to /api/group-chat/[slug]/[building].
//
// The subscription lifecycle is driven by openRoom() / closeRoom():
//
//   openRoom(slug, buildingId) →
//     1. GET /api/group-chat/<slug>/<building>
//        → { channelId, subscribeToken, messages, topics }
//     2. Hydrate the store with the backfill + topics list.
//     3. centrifuge.newSubscription(channelId, { token }) → live updates
//        funnel into the store via publication handlers.
//
//   closeRoom() →
//     unsubscribe + clear store.
//
// One channel per building is enough — messages carry `topicId` and
// the store buckets them so unread badges across every topic work
// off a single subscription (no need to mint a new subscribe token
// each time the user switches threads).
//
// We piggy-back on the singleton Centrifuge instance the positions
// realtime layer already opened — opening a second connection would
// duplicate the WebSocket and burn a second connection slot in the
// Centrifugo `client_concurrency` budget. The realtime module exposes
// `getCentrifuge()` for exactly this kind of side feature.
//
// Concurrency: openRoom is async, but the user can re-fire it (G key) or
// trigger closeRoom (scene leave) while a previous openRoom is still in
// flight. We use a monotonically-increasing `openEpoch` — every
// openRoom and closeRoom bumps it, and any in-flight openRoom that
// finds its captured epoch superseded bails out without touching state.

import type { PublicationContext, Subscription } from "centrifuge";

import { getCentrifuge, getSelfIdentity } from "@/game/realtime";

import type {
  GroupChatWire,
  GroupMessageRow,
  GroupTopicRow,
} from "../types";
import { TYPING_THROTTLE_MS } from "../types";
import { groupChatStore, type GroupChatRoom } from "./store";

interface HistoryResponse {
  channelId: string;
  subscribeToken: string;
  messages: GroupMessageRow[];
  topics: GroupTopicRow[];
  ownerParticipantKey: string;
  ownerName: string;
}

let activeSub: Subscription | null = null;
let typingPruneTimer: number | null = null;
let expiredTopicTimer: number | null = null;
// Bumped by every openRoom + closeRoom. In-flight openRoom captures
// this at entry and bails if it's been superseded by another call —
// stops a slow fetch from clobbering state after the user G-pressed
// twice or walked out of the house.
let openEpoch = 0;

export interface OpenRoomInput {
  slug: string;
  buildingId: string;
  buildingLabel: string;
}

/** Open the overlay for this room, fetch backfill, subscribe live. */
export async function openRoom(input: OpenRoomInput): Promise<void> {
  // If we're already in this exact room AND not in an error state,
  // treat the second G-press as a no-op. An errored room (transient
  // 503, network blip) falls through here so the user can retry by
  // pressing G again without ESC-ing first.
  const cur = groupChatStore.getState();
  if (
    cur.room?.slug === input.slug &&
    cur.room.buildingId === input.buildingId &&
    cur.open &&
    cur.status !== "error"
  ) {
    return;
  }
  // Tear down any prior subscription before swapping rooms. closeRoom
  // bumps the epoch, so we grab our own epoch *after* it returns.
  await closeRoom();
  const myEpoch = ++openEpoch;

  const tentative: GroupChatRoom = {
    slug: input.slug,
    buildingId: input.buildingId,
    buildingLabel: input.buildingLabel,
    channelId: "",
    ownerParticipantKey: "",
  };
  groupChatStore.openRoom(tentative);

  let body: HistoryResponse;
  try {
    const res = await fetch(
      `/api/group-chat/${encodeURIComponent(input.slug)}/${encodeURIComponent(input.buildingId)}`,
      { cache: "no-store" },
    );
    if (myEpoch !== openEpoch) return; // superseded — leave state to the new caller
    if (!res.ok) {
      groupChatStore.setError(`Couldn't open room (${res.status})`);
      return;
    }
    body = (await res.json()) as HistoryResponse;
  } catch (e) {
    if (myEpoch !== openEpoch) return;
    groupChatStore.setError(
      e instanceof Error ? e.message : "Network error opening room",
    );
    return;
  }
  if (myEpoch !== openEpoch) return;

  // Re-publish the room with the resolved channelId + owner key now
  // that the history endpoint told us about them.
  groupChatStore.openRoom({
    ...tentative,
    channelId: body.channelId,
    ownerParticipantKey: body.ownerParticipantKey,
  });
  groupChatStore.setReady(body.messages, body.topics);

  // Wire the live subscription. The connection is already open via
  // startRealtime() — we just attach another subscription to it.
  const c = getCentrifuge();
  if (!c) {
    groupChatStore.setError("Realtime not connected");
    return;
  }

  // Defensive: if a prior subscription to this channel is still
  // registered on the Centrifuge client (e.g. a previous close
  // didn't reach this code path, or a hot reload kept the singleton),
  // tear it down before creating a new one. Centrifuge throws
  // "Subscription to the channel X already exists" on duplicate
  // newSubscription calls.
  const existing = c.getSubscription(body.channelId);
  if (existing) {
    try {
      existing.unsubscribe();
      existing.removeAllListeners();
      c.removeSubscription(existing);
    } catch {
      // ignore — best-effort cleanup
    }
  }

  const sub = c.newSubscription(body.channelId, { token: body.subscribeToken });
  sub.on("publication", (ctx: PublicationContext) => {
    handleWire(ctx.data);
  });
  sub.on("error", (ctx) => {
    console.warn("[group-chat] sub error", ctx);
  });
  sub.subscribe();
  activeSub = sub;

  // Run the typing pruner while we're connected. 800ms is fast enough
  // that the "X is typing…" line clears within ~1s of the last pulse.
  if (typingPruneTimer === null) {
    typingPruneTimer = window.setInterval(() => {
      groupChatStore.pruneTyping();
    }, 800);
  }
  // Prune expired topics from the sidebar every 15s. Cheap — it only
  // walks the topic list. Anything freshly aged out disappears and,
  // if the active topic is the one that expired, we fall back to
  // #general (handled inside pruneExpiredTopics).
  if (expiredTopicTimer === null) {
    expiredTopicTimer = window.setInterval(() => {
      groupChatStore.pruneExpiredTopics();
    }, 15_000);
  }
}

export async function closeRoom(): Promise<void> {
  // Bump first so any in-flight openRoom bails before touching state.
  ++openEpoch;
  if (activeSub) {
    try {
      activeSub.unsubscribe();
      activeSub.removeAllListeners();
      // unsubscribe() drops the SERVER subscription but the
      // Centrifuge client still tracks the sub object in its
      // registry — the next newSubscription(sameChannel) would
      // throw "already exists". removeSubscription cleans that up.
      const c = getCentrifuge();
      c?.removeSubscription(activeSub);
    } catch {
      // ignore — sub may already be torn down
    }
    activeSub = null;
  }
  if (typingPruneTimer !== null) {
    window.clearInterval(typingPruneTimer);
    typingPruneTimer = null;
  }
  if (expiredTopicTimer !== null) {
    window.clearInterval(expiredTopicTimer);
    expiredTopicTimer = null;
  }
  groupChatStore.closeRoom();
}

/** Post a message into the currently active topic (or #general when
 *  activeTopicId is null). The optimistic UI lives entirely in the
 *  publication echo — the server publishes back to us. */
export async function postMessage(text: string): Promise<void> {
  const state = groupChatStore.getState();
  if (!state.room || state.status !== "ready") return;
  const trimmed = text.trim();
  if (!trimmed) return;
  await fetch(
    `/api/group-chat/${encodeURIComponent(state.room.slug)}/${encodeURIComponent(state.room.buildingId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "message",
        text: trimmed,
        topicId: state.activeTopicId,
      }),
    },
  );
}

let lastTypingSentAt = 0;

/** Tell the room we're typing in the active topic. Throttled so we
 *  publish at most one pulse every TYPING_THROTTLE_MS while the user
 *  holds keys down. */
export function publishTyping(): void {
  const state = groupChatStore.getState();
  if (!state.room || state.status !== "ready") return;
  const now = Date.now();
  if (now - lastTypingSentAt < TYPING_THROTTLE_MS) return;
  lastTypingSentAt = now;
  void fetch(
    `/api/group-chat/${encodeURIComponent(state.room.slug)}/${encodeURIComponent(state.room.buildingId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "typing", topicId: state.activeTopicId }),
    },
  );
}

/** Switch the composer to a different topic (null = #general). Pure
 *  store update — no network. Unread badge for the target topic
 *  clears in the store. */
export function switchTopic(topicId: string | null): void {
  groupChatStore.switchTopic(topicId);
}

/** Delete a topic. Owner-only server-side; UI should only expose the
 *  affordance when the viewer is the town owner. Instant local removal
 *  via the topic-deleted wire the server publishes back to us; we don't
 *  optimistically remove here so a 403 leaves the sidebar untouched. */
export async function deleteTopic(
  topicId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const state = groupChatStore.getState();
  if (!state.room || state.status !== "ready") {
    return { ok: false, error: "room-not-ready", status: 0 };
  }
  let res: Response;
  try {
    res = await fetch(
      `/api/group-chat/${encodeURIComponent(state.room.slug)}/${encodeURIComponent(state.room.buildingId)}/topics/${encodeURIComponent(topicId)}`,
      { method: "DELETE" },
    );
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "network",
      status: 0,
    };
  }
  if (!res.ok) {
    let error = String(res.status);
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) error = body.error;
    } catch {
      // ignore
    }
    return { ok: false, error, status: res.status };
  }
  return { ok: true };
}

/** Create a new topic in the current room. Server publishes a
 *  topic-created wire that lands in every open sidebar (including
 *  ours), so we don't add the topic locally — we just switch to it
 *  after the create returns. */
export async function createTopic(
  title: string,
): Promise<
  | { ok: true; topicId: string }
  | { ok: false; error: string; status: number }
> {
  const state = groupChatStore.getState();
  if (!state.room || state.status !== "ready") {
    return { ok: false, error: "room-not-ready", status: 0 };
  }
  const trimmed = title.trim();
  if (!trimmed) return { ok: false, error: "empty-title", status: 400 };
  let res: Response;
  try {
    res = await fetch(
      `/api/group-chat/${encodeURIComponent(state.room.slug)}/${encodeURIComponent(state.room.buildingId)}/topics`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      },
    );
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "network",
      status: 0,
    };
  }
  if (!res.ok) {
    let error = String(res.status);
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) error = body.error;
    } catch {
      // ignore
    }
    return { ok: false, error, status: res.status };
  }
  const body = (await res.json()) as { ok: true; topic: GroupTopicRow };
  // The wire echo also adds the topic to the store; guard against a
  // race where the HTTP response beats the WebSocket by adding it
  // here too (addTopic dedupes on id).
  groupChatStore.addTopic(body.topic);
  groupChatStore.switchTopic(body.topic.id);
  return { ok: true, topicId: body.topic.id };
}

function handleWire(data: unknown) {
  if (!data || typeof data !== "object") return;
  const wire = data as GroupChatWire;
  // Centrifugo broadcasts every publish back to the publisher too.
  // For typing pulses that means our own "I'm typing…" would show up
  // as a phantom indicator above our own input — drop self-echoes
  // before they ever land in the store.
  const selfKey = getSelfIdentity()?.participantKey;
  if (wire.type === "message") {
    groupChatStore.appendMessage({
      id: wire.id,
      channelId: wire.channelId,
      topicId: wire.topicId,
      authorKey: wire.authorKey,
      authorName: wire.authorName,
      isNpc: wire.isNpc,
      text: wire.text,
      createdAt: wire.createdAt,
    });
    // The author's typing indicator clears as soon as their message lands.
    groupChatStore.clearTyping(wire.topicId, wire.authorKey);
  } else if (wire.type === "typing") {
    if (selfKey && wire.authorKey === selfKey) return;
    groupChatStore.setTyping({
      topicId: wire.topicId,
      authorKey: wire.authorKey,
      authorName: wire.authorName,
      isNpc: wire.isNpc,
    });
  } else if (wire.type === "topic-created") {
    groupChatStore.addTopic(wire.topic);
  } else if (wire.type === "topic-deleted") {
    groupChatStore.removeTopic(wire.topicId);
  }
}
