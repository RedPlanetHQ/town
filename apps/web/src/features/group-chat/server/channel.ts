// Room channel naming + scope helpers.
//
// One channel per (town, building):
//
//   room:<slug>-<building>
//
// We sit alongside the existing channel families in lib/centrifugo.ts
// (`positions:`, `dm:`, `user:`) — same `-` separator convention so the
// Centrifugo namespace parser stays happy.
//
// The Centrifugo subscribe token gates who can join: realtime-token mints
// a token only for rooms inside the viewer's authorised town. Anyone with
// a valid visit cookie + the per-house `groupChatEnabled: true` flag on
// the building can join. The client must pass the channel id when asking
// for the token — see realtime-token route.

const ROOM_PREFIX = "room:";

export function roomChannel(slug: string, buildingId: string): string {
  return `${ROOM_PREFIX}${sanitize(slug)}-${sanitize(buildingId)}`;
}

// Conservative: only allow what plot ids + town slugs already use. If
// someone smuggles a colon or dash into a future building id we don't
// silently scramble the channel — we strip those chars so the channel
// id stays unambiguous.
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}
