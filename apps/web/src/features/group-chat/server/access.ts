// Shared access check: who is this person, are they allowed in the
// town, and does the building exist + opt in to group chat?
//
// Every group-chat server route runs through this so the per-house
// `groupChatEnabled` flag is enforced in one place, not echoed across
// every endpoint.

import type { Plot, PlotBuilding } from "@town/plot";

import { prisma } from "@/lib/db";
import { userParticipantKey } from "@/lib/participant";
import { resolveViewer, type ResolvedViewer } from "@/lib/viewer";

import { roomChannel } from "./channel";

export type GroupChatAccess = {
  viewer: ResolvedViewer;
  building: PlotBuilding;
  channelId: string;
  plot: Plot;
  /** participantKey for the town owner — `user:<ownerId>`. Both the
   *  history endpoint and the NPC reply pipeline use it to mark the
   *  resident's messages so the LLM and the UI can render an `(owner)`
   *  affordance instead of the raw display name. */
  ownerParticipantKey: string;
  /** Display name of the town owner — used in the LLM system prompt
   *  so NPCs can address the resident by name even when their
   *  messages arrive prefixed `[owner]`. */
  ownerName: string;
};

export type GroupChatAccessError =
  | "not-found"
  | "forbidden"
  | "no-plot"
  | "no-building"
  | "house-disabled";

const STATUS_FOR_ERROR: Record<GroupChatAccessError, number> = {
  "not-found": 404,
  forbidden: 403,
  "no-plot": 404,
  "no-building": 404,
  "house-disabled": 403,
};

export function groupChatErrorResponse(error: GroupChatAccessError): Response {
  return new Response(JSON.stringify({ error }), {
    status: STATUS_FOR_ERROR[error],
    headers: { "content-type": "application/json" },
  });
}

/** Resolve viewer + validate building + return the room channel id.
 *  Used by every group-chat endpoint as the first step. */
export async function resolveGroupChatAccess(
  slug: string,
  buildingId: string,
): Promise<GroupChatAccess | { error: GroupChatAccessError }> {
  const view = await resolveViewer(slug);
  if ("error" in view) return { error: view.error };

  // The plot lives on the town's row — visitors read the same blob.
  // Pull the owner's display name in the same round-trip so we don't
  // make a second query per request.
  const [row, owner] = await Promise.all([
    prisma.plotRow.findUnique({ where: { townId: view.town.id } }),
    prisma.user.findUnique({
      where: { id: view.town.ownerId },
      select: { name: true },
    }),
  ]);
  if (!row) return { error: "no-plot" };

  const plot = row.json as unknown as Plot;
  const building = plot.buildings.find((b) => b.id === buildingId);
  if (!building) return { error: "no-building" };
  // TEMP: group chat is on for every building — the per-house
  // opt-in flag (`building.groupChatEnabled`) is bypassed during
  // the rollout. Restore the guard by re-enabling this line:
  //   if (!building.groupChatEnabled) return { error: "house-disabled" };

  return {
    viewer: view,
    building,
    channelId: roomChannel(slug, building.id),
    plot,
    ownerParticipantKey: userParticipantKey(view.town.ownerId),
    ownerName: owner?.name || "the resident",
  };
}
