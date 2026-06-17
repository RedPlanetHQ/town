// Centrifugo subscription for one room channel + the wire client that
// talks to /api/group-chat/[slug]/[building].
//
// The subscription lifecycle is driven by openRoom() / closeRoom():
//
//   openRoom(slug, buildingId) →
//     1. GET /api/group-chat/<slug>/<building>
//        → { channelId, subscribeToken, messages }
//     2. Hydrate the store with the backfill.
//     3. centrifuge.newSubscription(channelId, { token }) → live updates
//        funnel into the store via publication handlers.
//
//   closeRoom() →
//     unsubscribe + clear store.
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
} from "../types";
import { TYPING_THROTTLE_MS } from "../types";
import { groupChatStore, type GroupChatRoom } from "./store";

interface HistoryResponse {
  channelId: string;
  subscribeToken: string;
  messages: GroupMessageRow[];
}

let activeSub: Subscription | null = null;
let typingPruneTimer: number | null = null;
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

  // Re-publish the room with the resolved channelId now that we know it.
  groupChatStore.openRoom({
    ...tentative,
    channelId: body.channelId,
  });
  groupChatStore.setReady(body.messages);

  // Wire the live subscription. The connection is already open via
  // startRealtime() — we just attach another subscription to it.
  const c = getCentrifuge();
  if (!c) {
    groupChatStore.setError("Realtime not connected");
    return;
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
}

export async function closeRoom(): Promise<void> {
  // Bump first so any in-flight openRoom bails before touching state.
  ++openEpoch;
  if (activeSub) {
    try {
      activeSub.unsubscribe();
      activeSub.removeAllListeners();
    } catch {
      // ignore — sub may already be torn down
    }
    activeSub = null;
  }
  if (typingPruneTimer !== null) {
    window.clearInterval(typingPruneTimer);
    typingPruneTimer = null;
  }
  groupChatStore.closeRoom();
}

/** Post a message into the active room. The optimistic UI lives entirely
 *  in the publication echo — the server publishes back to us. */
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
      body: JSON.stringify({ kind: "message", text: trimmed }),
    },
  );
}

let lastTypingSentAt = 0;

/** Tell the room we're typing. Throttled so we publish at most one
 *  pulse every TYPING_THROTTLE_MS while the user holds keys down. */
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
      body: JSON.stringify({ kind: "typing" }),
    },
  );
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
      authorKey: wire.authorKey,
      authorName: wire.authorName,
      isNpc: wire.isNpc,
      text: wire.text,
      createdAt: wire.createdAt,
    });
    // The author's typing indicator clears as soon as their message lands.
    groupChatStore.clearTyping(wire.authorKey);
  } else if (wire.type === "typing") {
    if (selfKey && wire.authorKey === selfKey) return;
    groupChatStore.setTyping({
      authorKey: wire.authorKey,
      authorName: wire.authorName,
      isNpc: wire.isNpc,
    });
  }
}
