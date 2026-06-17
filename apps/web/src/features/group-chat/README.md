# group-chat

Per-house multi-party chat with ambient NPC responses. Walk into a house
that has it enabled, press **G**, and you join a Twitch-style overlay
shared with everyone (humans + NPCs) in that house.

## Enabling

Single switch: set `groupChatEnabled: true` on the building in your
plot. That can be in `packages/plot/src/default.json` (ships to fresh
towns) or any specific user's `PlotRow.json` row.

`HOME` in `default.json` ships with it on.

## Disabling

Flip `groupChatEnabled: false` on the building. The `[G]` prompt
vanishes; the API returns `house-disabled` to anyone hitting it
directly.

## Deleting

This folder is self-contained. The only outside references are:

- `apps/web/src/app/api/group-chat/[slug]/[building]/route.ts` — thin re-export
- `apps/web/src/game/scenes/interior.ts` — one `mountGroupChatForScene(...)` call + a 2-line NPC gate
- `apps/web/src/ui/TownGame.tsx` — two component mounts
- `apps/web/src/game/realtime.ts` — added `getCentrifuge()` (shared WebSocket) and uses `getSelfIdentity()` for the self-echo filter on typing pulses
- `packages/plot/src/types.ts` — the `groupChatEnabled?: boolean` field on `PlotBuilding`
- `packages/db/prisma/schema.prisma` — the `GroupMessage` model + its migration

Remove those touchpoints + this folder + the model and the feature is gone.

## NPC behaviour notes

- **No tools.** Group-chat NPCs don't get `memory_search` or skill
  injection (which `/api/npc-chat` does). Replies are driven entirely
  by the authored prompt + last 20 turns of room history. The premise
  is ambient room dynamics, not deep grounded conversation — for the
  latter, the player walks over and opens a 1-1 chat.
- **Reply not cancelled on leave.** Once the moderator picks an NPC,
  the stream runs to completion and the row is persisted even if the
  triggering player walks out of the house. The reply shows up in the
  1-hour backfill for anyone who re-enters; cancelling would discard
  tokens already spent.

## Layout

```
index.ts                 — public exports
types.ts                 — wire shapes shared between server + client
client/
  store.ts               — isolated pub/sub (not in global ui/store.ts)
  channel.ts             — Centrifugo subscription for one room channel
  attach.ts              — mountGroupChatForScene(k, opts) called from interior.ts
  useGroupChatState.ts   — React bridge
ui/
  GroupChatSurface.tsx   — bottom-right non-modal overlay
  GroupChatPrompt.tsx    — floating "[G] Group chat" hint
server/
  route.ts               — POST /api/group-chat/[slug]/[building]
  history.ts             — GET /api/group-chat/[slug]/[building]
  access.ts              — resolve viewer + validate per-house flag
  channel.ts             — room channel naming
  moderator.ts           — picks at most one NPC per human message
  npc-reply.ts           — Stage 2: streamText with last-20 messages
```
