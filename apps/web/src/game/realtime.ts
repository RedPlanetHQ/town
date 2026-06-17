// Realtime client (Centrifugo).
//
// Two responsibilities:
//   1. Connect to Centrifugo with a token fetched from
//      /api/towns/[slug]/realtime-token, then subscribe to the positions
//      channel so we can render every other player in the town.
//   2. Publish our own position whenever the local player crosses a tile,
//      and expose presence + position updates to subscribers (the kaplay
//      scene + the proximity / chat UI).
//
// Connection lifecycle is keyed off the React mount in TownGame. We only
// fire the realtime layer for the owner + visitor-with-cookie cases —
// guests-on-/ (root playground) don't get one.

import { Centrifuge, type PublicationContext, type SubscribedContext } from "centrifuge";

import { armNotifications, showMessageNotification } from "./notify";
import { playMessageDing } from "./sound";

const LOG = "[realtime]";

export type RemotePlayer = {
  participantKey: string;
  name: string;
  character: string;
  tx: number;
  ty: number;
  facing: "up" | "down" | "left" | "right";
  // True when the sender hasn't moved for IDLE_THRESHOLD_MS and hasn't
  // had a modal open in that window — surfaced so remote viewers can
  // render the sleeping animation. Default false on absent.
  idle: boolean;
  // Which scene the remote is currently in. `"overworld"` for the open
  // town, `"interior:<BuildingKey>"` (e.g. `"interior:HOME"`) for
  // anyone standing inside a building. Used by scene renderers + the
  // proximity tick to scope remote sprites to the same room as the
  // local viewer — otherwise a visitor who walks through the front
  // door keeps being rendered at the door tile because the heartbeat
  // re-publishes the last broadcast position.
  scene: string;
  // Local clock when we last received an update for this player. Used
  // by the heartbeat expiry sweep to drop ghosts when a tab closes
  // without a clean leave.
  lastSeen: number;
};

type PositionPayload = {
  k: string;          // participantKey
  n: string;          // name
  ch: string;         // character sprite key
  tx: number;
  ty: number;
  f: RemotePlayer["facing"];
  // Optional sleeping flag. Older clients omit it; treat as false.
  i?: boolean;
  // Optional scene id. Older clients omit it; treat as "overworld".
  s?: string;
};

const SCENE_OVERWORLD = "overworld";

type Listener = () => void;

let centrifuge: Centrifuge | null = null;
let positionsSub: ReturnType<Centrifuge["newSubscription"]> | null = null;
let inboxSub: ReturnType<Centrifuge["newSubscription"]> | null = null;
let self: Pick<RemotePlayer, "participantKey" | "name" | "character"> | null = null;
let activeSlug: string | null = null;
// Latest position the scene asked us to publish. Cached so that if the
// sub wasn't yet `subscribed` when the scene first called us (race on
// boot), we can re-publish it as soon as the channel opens.
let lastSent:
  | {
      tx: number;
      ty: number;
      facing: RemotePlayer["facing"];
      idle: boolean;
      scene: string;
    }
  | null = null;
// Which scene the local player is in. Cached at module level so the
// player entity (sleep/wake publishes) and the heartbeat tick don't
// have to thread it through every call. Scenes call `setLocalScene` on
// entry; defaults to overworld until told otherwise.
let localScene: string = SCENE_OVERWORLD;
const remotes = new Map<string, RemotePlayer>();
const listeners = new Set<Listener>();

export function getActiveTownSlug(): string | null {
  return activeSlug;
}

// Expose the singleton Centrifuge instance so side features (e.g.
// group chat) can attach extra subscriptions without opening a second
// WebSocket connection. Returns null before startRealtime() runs or
// after stop() — callers must handle the null case.
export function getCentrifuge(): Centrifuge | null {
  return centrifuge;
}

// Module-level accessors so the kaplay scene (which isn't React) can
// reach the live state without holding a handle.
export function publishLocalPosition(input: {
  tx: number;
  ty: number;
  facing: RemotePlayer["facing"];
  idle?: boolean;
}): void {
  publishLocal(input.tx, input.ty, input.facing, input.idle ?? false, localScene);
}

// Update the cached local scene id and immediately re-publish so other
// viewers stop seeing the stale "still at the door" position the
// heartbeat would otherwise keep re-sending.
export function setLocalScene(scene: string): void {
  if (scene === localScene) return;
  localScene = scene;
  if (lastSent) {
    publishLocal(lastSent.tx, lastSent.ty, lastSent.facing, lastSent.idle, scene);
  }
}

export function getLocalScene(): string {
  return localScene;
}

export function getRemotePlayers(): RemotePlayer[] {
  return Array.from(remotes.values());
}

// Same list, filtered to remotes whose `scene` matches the caller's
// current scene. Used by the overworld + each interior so a visitor
// who walked into a house doesn't appear stuck at the door tile to the
// owner outside, and so co-occupants of the same interior see each
// other.
export function getRemotePlayersForScene(scene: string): RemotePlayer[] {
  const out: RemotePlayer[] = [];
  for (const p of remotes.values()) {
    if (p.scene === scene) out.push(p);
  }
  return out;
}

export function onRemotesChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getSelfIdentity(): Pick<
  RemotePlayer,
  "participantKey" | "name" | "character"
> | null {
  return self;
}

// Per-other-player "is awaiting a reply from me" flag. Populated by
// TownGame's pending poller; remotePlayer.ts reads this to draw a 💬
// badge above the matching sprite.
const pending = new Set<string>();
const pendingListeners = new Set<Listener>();

export function setPendingKeys(keys: string[]): void {
  let changed = keys.length !== pending.size;
  if (!changed) {
    for (const k of keys) {
      if (!pending.has(k)) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return;
  pending.clear();
  for (const k of keys) pending.add(k);
  for (const fn of pendingListeners) fn();
}

// Incremental add — used by the inbox-channel push so a new inbound DM
// flips the dot before the next poll cycle. The poll still runs as a
// backstop and reconciles the full set.
export function addPendingKey(key: string): void {
  if (pending.has(key)) return;
  pending.add(key);
  for (const fn of pendingListeners) fn();
}

export function isPending(key: string): boolean {
  return pending.has(key);
}

export function onPendingChange(fn: Listener): () => void {
  pendingListeners.add(fn);
  return () => {
    pendingListeners.delete(fn);
  };
}

// How long after the last heartbeat we keep a remote player on screen.
// Local clients publish their position every HEARTBEAT_MS even when
// standing still, so any gap longer than this means the tab actually
// went away. 30 s = 3× the heartbeat cadence, so a single dropped
// publish still keeps the avatar around but a closed tab clears within
// ~half a minute.
const STALE_MS = 30_000;
// Cadence at which we re-publish lastSent (keeps remote viewers from
// expiring an idle but still-present player). Pick a value much
// smaller than STALE_MS so a single missed heartbeat doesn't kill the
// avatar.
const HEARTBEAT_MS = 10_000;

function notify() {
  for (const l of listeners) l();
}

function applyPublication(data: unknown) {
  if (!data || typeof data !== "object") return;
  const p = data as PositionPayload;
  if (typeof p.k !== "string") return;
  if (p.k === self?.participantKey) {
    // Our own echo — Centrifugo broadcasts to all subscribers including
    // the publisher. Drop quietly.
    return;
  }
  const scene = typeof p.s === "string" && p.s.length > 0 ? p.s : SCENE_OVERWORLD;
  console.log(
    `${LOG} remote update key=${p.k} name=${p.n} tile=${p.tx},${p.ty} idle=${p.i ?? false} scene=${scene}`,
  );
  remotes.set(p.k, {
    participantKey: p.k,
    name: p.n,
    character: p.ch,
    tx: p.tx,
    ty: p.ty,
    facing: p.f,
    idle: p.i === true,
    scene,
    lastSeen: performance.now(),
  });
  notify();
}

function expireStale() {
  const now = performance.now();
  let changed = false;
  for (const [key, p] of remotes) {
    if (now - p.lastSeen > STALE_MS) {
      remotes.delete(key);
      changed = true;
    }
  }
  if (changed) notify();
}

let staleTimer: number | null = null;
let heartbeatTimer: number | null = null;

export type RealtimeBootInput = {
  slug: string;
};

export type RealtimeHandle = {
  stop(): void;
};

export async function startRealtime({
  slug,
}: RealtimeBootInput): Promise<RealtimeHandle | null> {
  console.log(`${LOG} startRealtime slug=${slug}`);

  let bootstrap: {
    token: string;
    url: string;
    participantKey: string;
    displayName: string;
    character: string;
    positionsChannel: string;
    inboxChannel?: string;
    inboxToken?: string;
  };
  try {
    const res = await fetch(`/api/towns/${slug}/realtime-token`, {
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `${LOG} /realtime-token status=${res.status} body=${body.slice(0, 200)}`,
      );
      return null;
    }
    bootstrap = await res.json();
    console.log(
      `${LOG} token ok participantKey=${bootstrap.participantKey} channel=${bootstrap.positionsChannel} url=${bootstrap.url}`,
    );
  } catch (e) {
    console.warn(`${LOG} /realtime-token fetch threw`, e);
    return null;
  }

  const url = bootstrap.url;
  if (!url) {
    console.warn(
      `${LOG} server returned empty url — set CENTRIFUGO_PUBLIC_URL on the web container`,
    );
    return null;
  }

  self = {
    participantKey: bootstrap.participantKey,
    name: bootstrap.displayName,
    character: bootstrap.character,
  };
  activeSlug = slug;

  const c = new Centrifuge(url, {
    token: bootstrap.token,
    getToken: async () => {
      const r = await fetch(`/api/towns/${slug}/realtime-token`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("realtime-token refresh failed");
      const body = await r.json();
      return body.token as string;
    },
  });
  centrifuge = c;

  c.on("connecting", (ctx) => console.log(`${LOG} centrifuge connecting`, ctx));
  c.on("connected", (ctx) => console.log(`${LOG} centrifuge connected`, ctx));
  c.on("disconnected", (ctx) =>
    console.warn(`${LOG} centrifuge disconnected`, ctx),
  );
  c.on("error", (ctx) => console.warn(`${LOG} centrifuge error`, ctx));

  const sub = c.newSubscription(bootstrap.positionsChannel);
  positionsSub = sub;

  sub.on("publication", (ctx: PublicationContext) => {
    applyPublication(ctx.data);
  });
  sub.on("subscribed", (ctx: SubscribedContext) => {
    console.log(`${LOG} subscribed to ${bootstrap.positionsChannel}`, ctx);
    if (lastSent) {
      publishLocal(
        lastSent.tx,
        lastSent.ty,
        lastSent.facing,
        lastSent.idle,
        lastSent.scene,
      );
    }
  });
  sub.on("subscribing", () =>
    console.log(`${LOG} subscribing to ${bootstrap.positionsChannel}`),
  );
  sub.on("unsubscribed", (ctx) =>
    console.warn(`${LOG} unsubscribed from ${bootstrap.positionsChannel}`, ctx),
  );
  sub.on("error", (ctx) =>
    console.warn(`${LOG} subscription error`, ctx),
  );

  sub.subscribe();

  // Per-recipient inbox channel — one persistent sub for the entire
  // session that receives a notification envelope every time a DM
  // arrives for us, regardless of which conversation it belongs to.
  // Drives the ding sound + the pending dot.
  if (bootstrap.inboxChannel && bootstrap.inboxToken) {
    const ibx = c.newSubscription(bootstrap.inboxChannel, {
      token: bootstrap.inboxToken,
    });
    inboxSub = ibx;
    ibx.on("publication", (ctx: PublicationContext) => {
      const data = ctx.data as
        | {
            type?: string;
            fromKey?: string;
            fromName?: string;
            preview?: string;
            townSlug?: string;
          }
        | undefined
        | null;
      if (!data || data.type !== "dm") return;
      if (typeof data.fromKey !== "string" || !data.fromKey) return;
      // Don't ding for our own echoes — server doesn't publish to the
      // sender's inbox, but guard anyway in case multi-tab sessions
      // ever start cross-publishing.
      if (data.fromKey === self?.participantKey) return;
      addPendingKey(data.fromKey);
      playMessageDing();
      showMessageNotification({
        fromKey: data.fromKey,
        fromName: data.fromName || "New message",
        preview: data.preview || "",
        townSlug: data.townSlug || activeSlug || "",
      });
    });
    ibx.on("subscribed", () =>
      console.log(`${LOG} subscribed to ${bootstrap.inboxChannel}`),
    );
    ibx.on("error", (ctx) =>
      console.warn(`${LOG} inbox subscription error`, ctx),
    );
    ibx.subscribe();
  }

  // Arm OS-notification permission request. Permission can only be
  // requested from a user gesture, so this hooks a one-shot keydown /
  // pointerdown listener that fires the prompt on the player's first
  // interaction with the page.
  armNotifications();

  c.connect();

  if (staleTimer === null) {
    staleTimer = window.setInterval(expireStale, 5000);
  }
  // Heartbeat — re-publish lastSent so remote viewers don't expire us
  // while we're standing still (or sleeping). Kicks in once the scene
  // has called publishLocalPosition at least once.
  if (heartbeatTimer === null) {
    heartbeatTimer = window.setInterval(() => {
      if (!lastSent) return;
      publishLocal(
        lastSent.tx,
        lastSent.ty,
        lastSent.facing,
        lastSent.idle,
        lastSent.scene,
      );
    }, HEARTBEAT_MS);
  }

  return { stop };
}

function publishLocal(
  tx: number,
  ty: number,
  facing: RemotePlayer["facing"],
  idle: boolean,
  scene: string,
): void {
  lastSent = { tx, ty, facing, idle, scene };
  if (!positionsSub || !self) {
    console.log(
      `${LOG} publishLocal queued (sub not ready) tx=${tx} ty=${ty} idle=${idle} scene=${scene}`,
    );
    return;
  }
  const payload: PositionPayload = {
    k: self.participantKey,
    n: self.name,
    ch: self.character,
    tx,
    ty,
    f: facing,
    i: idle,
    s: scene,
  };
  positionsSub.publish(payload).then(
    () => {
      console.log(
        `${LOG} publish ok tx=${tx} ty=${ty} idle=${idle} scene=${scene}`,
      );
    },
    (err) => {
      console.warn(`${LOG} publish failed`, err);
    },
  );
}

function stop(): void {
  positionsSub?.unsubscribe();
  positionsSub?.removeAllListeners();
  positionsSub = null;
  inboxSub?.unsubscribe();
  inboxSub?.removeAllListeners();
  inboxSub = null;
  centrifuge?.disconnect();
  centrifuge = null;
  self = null;
  activeSlug = null;
  lastSent = null;
  localScene = SCENE_OVERWORLD;
  remotes.clear();
  if (staleTimer !== null) {
    window.clearInterval(staleTimer);
    staleTimer = null;
  }
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  notify();
}
