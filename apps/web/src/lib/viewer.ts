// Resolve the viewer's participant identity for a given town slug.
// Used by every realtime / DM endpoint so the participant key is computed
// in one place (cookie shape + auth precedence in one helper).

import { cookies } from "next/headers";

import { prisma } from "./db";
import { guestParticipantKey, userParticipantKey } from "./participant";
import { getSessionFromCookie } from "./session";
import { getTownBySlug } from "./town";
import { parseVisitorCookie, visitorCookieName } from "./town-code";

export type ResolvedViewer = {
  // Centrifugo + Conversation rows both index on this.
  participantKey: string;
  displayName: string;
  // Sprite key the viewer appears as in this town. Owner's User.character
  // when isOwner, the visitor cookie's `ch` otherwise. Null for the
  // legacy case where the column hasn't been backfilled.
  character: string | null;
  // The town row we resolved against — caller usually wants this anyway.
  town: NonNullable<Awaited<ReturnType<typeof getTownBySlug>>>;
  isOwner: boolean;
  // Town User.id when the viewer is signed in (owner OR signed-in visitor),
  // null for an anonymous guest. The visitor-grant feature keys grants
  // on this — only signed-in visitors can lend their CORE account.
  userId: string | null;
};

export type ResolveError =
  | "not-found"
  | "forbidden";

export async function resolveViewer(
  slug: string,
): Promise<ResolvedViewer | { error: ResolveError }> {
  const town = await getTownBySlug(slug);
  if (!town) return { error: "not-found" };

  const session = await getSessionFromCookie();
  const isOwner = !!session && session.user.id === town.ownerId;
  if (isOwner && session) {
    const owner = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { character: true },
    });
    return {
      participantKey: userParticipantKey(session.user.id),
      displayName: session.user.name,
      character: owner?.character ?? null,
      town,
      isOwner: true,
      userId: session.user.id,
    };
  }

  const jar = await cookies();
  const visitor = parseVisitorCookie(jar.get(visitorCookieName(slug))?.value);
  if (!visitor || visitor.c !== town.shareCode) return { error: "forbidden" };

  if (session) {
    return {
      participantKey: userParticipantKey(session.user.id),
      displayName: session.user.name || visitor.n,
      character: visitor.ch,
      town,
      isOwner: false,
      userId: session.user.id,
    };
  }
  return {
    participantKey: guestParticipantKey(visitor.g),
    displayName: visitor.n,
    character: visitor.ch,
    town,
    isOwner: false,
    userId: null,
  };
}
