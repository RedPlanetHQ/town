// Shared access check: who is this person, are they allowed in the
// town, and does the building exist + opt in to group chat?
//
// Every group-chat server route runs through this so the per-house
// `groupChatEnabled` flag is enforced in one place, not echoed across
// every endpoint.

import type { Plot, PlotBuilding } from "@town/plot";

import { prisma } from "@/lib/db";
import { resolveViewer, type ResolvedViewer } from "@/lib/viewer";

import { roomChannel } from "./channel";

export type GroupChatAccess = {
  viewer: ResolvedViewer;
  building: PlotBuilding;
  channelId: string;
  plot: Plot;
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

  // The plot lives on the town owner's row — visitors read the same blob.
  const row = await prisma.plotRow.findFirst({
    where: { userId: view.town.ownerId },
  });
  if (!row) return { error: "no-plot" };

  const plot = row.json as unknown as Plot;
  const building = plot.buildings.find((b) => b.id === buildingId);
  if (!building) return { error: "no-building" };
  if (!building.groupChatEnabled) return { error: "house-disabled" };

  return {
    viewer: view,
    building,
    channelId: roomChannel(slug, building.id),
    plot,
  };
}
