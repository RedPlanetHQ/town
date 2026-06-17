// GET /api/towns/[slug]/realtime-token
//
// Mints a Centrifugo connection token for the current viewer of the town
// and surfaces the positions channel + viewer identity so the browser can
// hand both to centrifuge-js.
//
// Owner / signed-in visitor → user:<userId>
// Guest visitor             → guest:<visitorCookie.g>
// No matching cookie / not a visitor → 403.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  mintConnectionToken,
  mintSubscribeToken,
  positionsChannel,
  userInboxChannel,
} from "@/lib/centrifugo";
import { OWNER_DEFAULT_CHARACTER } from "@/lib/characters";
import { prisma } from "@/lib/db";
import {
  guestParticipantKey,
  userParticipantKey,
} from "@/lib/participant";
import { getSessionFromCookie } from "@/lib/session";
import { getTownBySlug } from "@/lib/town";
import { parseVisitorCookie, visitorCookieName } from "@/lib/town-code";

type Params = { slug: string };

export async function GET(_req: Request, ctx: { params: Promise<Params> }) {
  const { slug } = await ctx.params;
  const town = await getTownBySlug(slug);
  if (!town) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  const session = await getSessionFromCookie();
  const isOwner = !!session && session.user.id === town.ownerId;

  let participantKey: string;
  let displayName: string;
  let character: string;

  if (isOwner && session) {
    const owner = await prisma.user.findUnique({
      where: { id: town.ownerId },
      select: { character: true, name: true },
    });
    participantKey = userParticipantKey(session.user.id);
    displayName = owner?.name ?? session.user.name;
    character = owner?.character ?? OWNER_DEFAULT_CHARACTER;
  } else {
    const jar = await cookies();
    const visitor = parseVisitorCookie(
      jar.get(visitorCookieName(slug))?.value,
    );
    if (!visitor || visitor.c !== town.shareCode) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (session) {
      participantKey = userParticipantKey(session.user.id);
      displayName = session.user.name || visitor.n;
    } else {
      participantKey = guestParticipantKey(visitor.g);
      displayName = visitor.n;
    }
    character = visitor.ch;
  }

  try {
    const inboxChannel = userInboxChannel(participantKey);
    const [token, inboxToken] = await Promise.all([
      mintConnectionToken({
        sub: participantKey,
        info: {
          name: displayName,
          character,
          slug,
        },
      }),
      mintSubscribeToken({
        sub: participantKey,
        channel: inboxChannel,
      }),
    ]);
    // Ship the public WebSocket URL alongside the token so the browser
    // doesn't depend on `NEXT_PUBLIC_*` (which would inline at build).
    // Server-side env vars resolve per request — set CENTRIFUGO_PUBLIC_URL
    // on the `web` container and a container restart picks up the change
    // with no rebuild needed.
    const url =
      process.env.CENTRIFUGO_PUBLIC_URL ||
      process.env.NEXT_PUBLIC_CENTRIFUGO_URL ||
      "";
    return NextResponse.json({
      token,
      url,
      participantKey,
      displayName,
      character,
      positionsChannel: positionsChannel(slug),
      inboxChannel,
      inboxToken,
    });
  } catch (e) {
    console.error("[realtime-token] failed to mint", e);
    return NextResponse.json(
      { error: "realtime-disabled" },
      { status: 503 },
    );
  }
}
