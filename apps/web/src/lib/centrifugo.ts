// Server-side Centrifugo helpers.
//
// Two things we need from this module:
//   1. Mint a connection JWT the browser passes when opening the WebSocket.
//   2. Mint a per-channel subscription JWT for DM channels (positions are
//      open to any authenticated connection within the slug — we trust the
//      client to subscribe to its own town's positions channel).
//   3. Publish a message into a channel server-side (used by the DM API to
//      fan-out persisted messages to live subscribers).
//
// All token math goes through `jose` so we don't drag in jsonwebtoken.

import { SignJWT } from "jose";

const CONNECTION_TOKEN_TTL_S = 60 * 60; // 1h — re-mint as needed
const SUBSCRIBE_TOKEN_TTL_S = 60 * 60;

function getSecret(): Uint8Array {
  const s = process.env.CENTRIFUGO_TOKEN_HMAC_SECRET;
  if (!s) {
    throw new Error(
      "CENTRIFUGO_TOKEN_HMAC_SECRET is not set — realtime cannot be issued",
    );
  }
  return new TextEncoder().encode(s);
}

export type ConnectionTokenInput = {
  // Stable identifier Centrifugo uses for presence + history.
  sub: string;
  // Anything the front-end wants Centrifugo to mirror back via presence.
  // Stays inside Centrifugo's `info`.
  info?: Record<string, unknown>;
};

export async function mintConnectionToken({
  sub,
  info,
}: ConnectionTokenInput): Promise<string> {
  const jwt = new SignJWT({
    ...(info ? { info } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + CONNECTION_TOKEN_TTL_S);
  return jwt.sign(getSecret());
}

export type SubscribeTokenInput = {
  sub: string;
  channel: string;
  info?: Record<string, unknown>;
};

export async function mintSubscribeToken({
  sub,
  channel,
  info,
}: SubscribeTokenInput): Promise<string> {
  const jwt = new SignJWT({
    channel,
    ...(info ? { info } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SUBSCRIBE_TOKEN_TTL_S);
  return jwt.sign(getSecret());
}

// HTTP publish via Centrifugo's API endpoint. Wraps the v2 endpoint:
// `POST {base}/api/publish` with API key in the Authorization header.
export async function publish(channel: string, data: unknown): Promise<void> {
  const base = process.env.CENTRIFUGO_API_BASE;
  const key = process.env.CENTRIFUGO_API_KEY;
  if (!base || !key) {
    // Surface as a warning rather than throwing — the rest of the app
    // (DB write, HTTP response) still functions; only live fan-out is lost.
    console.warn(
      "[centrifugo.publish] CENTRIFUGO_API_BASE or CENTRIFUGO_API_KEY missing — skipping live publish",
    );
    return;
  }
  try {
    const res = await fetch(`${base}/api/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-Key": key,
      },
      body: JSON.stringify({ channel, data }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[centrifugo.publish] non-OK status=${res.status} body=${body.slice(0, 200)}`,
      );
    }
  } catch (e) {
    console.warn("[centrifugo.publish] network error", e);
  }
}

// Channel name builders. Keep them centralized so the server + client + the
// gates all agree on the wire format.
export function positionsChannel(slug: string): string {
  return `positions:${slug}`;
}

// `aKey` and `bKey` are sorted before joining so the two participants
// agree on the channel name regardless of who joined first.
export function dmChannel(slug: string, a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  // Centrifugo channel names accept ASCII; replace `:` from participant
  // keys to avoid breaking the namespace parser. Participant keys are of
  // the form "user:<id>" or "guest:<id>".
  return `dm:${slug}-${lo.replace(/:/g, "_")}-${hi.replace(/:/g, "_")}`;
}

// Per-recipient "inbox" channel. One persistent subscription per browser
// session that receives a tiny envelope every time the participant gets
// a new DM, regardless of who the sender is or which conversations are
// currently open. Lets the client play a notification sound and refresh
// the pending-dot set without polling.
export function userInboxChannel(participantKey: string): string {
  return `user:${participantKey.replace(/:/g, "_")}`;
}
