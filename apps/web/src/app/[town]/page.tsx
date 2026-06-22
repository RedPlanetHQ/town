// /{town_slug} — the named town view.
//
//  • Owner   → full TownGame.
//  • Visitor with valid visit cookie → read-only TownGame.
//  • Anyone else → <VisitorGate> (name + share code).
//
// Slug is server-resolved against Town.slug. 404 if no such town. The
// owner check is by Session.userId === Town.ownerId.

import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";

import { OWNER_DEFAULT_CHARACTER } from "@/lib/characters";
import { prisma } from "@/lib/db";
import { guestParticipantKey, userParticipantKey } from "@/lib/participant";
import { getSessionFromCookie } from "@/lib/session";
import { recordTownActivity } from "@/lib/town-activity";
import { getTownBySlug } from "@/lib/town";
import { normalizeCode, parseVisitorCookie, visitorCookieName } from "@/lib/town-code";
import { TownGame } from "@/ui/TownGame";
import { VisitorGate } from "@/ui/VisitorGate";

// OG + Twitter card. Builds absolute URLs from the live request host
// so the meta tags work behind ngrok, on prod, and on localhost without
// having to maintain a NEXT_PUBLIC_SITE_URL — scrapers like Twitter's
// Card validator and LinkedIn's Post Inspector need a URL they can
// fetch, and `metadataBase` defaults to localhost in dev.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ town: string }>;
}): Promise<Metadata> {
  const { town: slug } = await params;
  const town = await getTownBySlug(slug);
  if (!town) return {};

  const hdrs = await headers();
  const host =
    hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "town.getcore.me";
  const proto =
    hdrs.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${proto}://${host}`;

  // Layout's title template is "%s · town", so passing the bare name
  // here renders as "Harshithton · town" in the browser tab + on
  // social cards.
  const ownerRow = await prisma.user.findUnique({
    where: { id: town.ownerId },
    select: { name: true },
  });
  const ownerName = ownerRow?.name ?? "the owner";
  const title = town.name;
  const ogTitle = `${town.name} · town`;
  const description = `Tour ${town.name} — a pixel-art town built by ${ownerName} on CORE. Walk around, ping the NPCs, see what's been on their mind.`;
  const image = `${origin}/api/towns/${slug}/postcard.png`;
  const pageUrl = `${origin}/${slug}`;

  return {
    title,
    description,
    openGraph: {
      title: ogTitle,
      description,
      type: "website",
      url: pageUrl,
      images: [{ url: image, width: 1200, height: 628, alt: ogTitle }],
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description,
      images: [image],
    },
  };
}

export default async function TownPage({
  params,
  searchParams,
}: {
  params: Promise<{ town: string }>;
  searchParams: Promise<{ invite_code?: string | string[] }>;
}) {
  const { town: slug } = await params;
  const sp = await searchParams;
  const rawInvite = Array.isArray(sp.invite_code)
    ? sp.invite_code[0]
    : sp.invite_code;
  const initialInviteCode = rawInvite ? normalizeCode(rawInvite) : "";
  const town = await getTownBySlug(slug);
  if (!town) notFound();

  const session = await getSessionFromCookie();
  const isOwner = !!session && session.user.id === town.ownerId;

  if (isOwner) {
    const owner = await prisma.user.findUnique({
      where: { id: town.ownerId },
      select: { character: true, name: true },
    });
    // Log the owner walking back into their own town. Dedupe in
    // recordTownActivity keeps soft navs / refreshes from spamming the
    // feed — we re-emit at most once per hour.
    void recordTownActivity({
      townSlug: town.slug,
      kind: "visit",
      subjectKey: userParticipantKey(town.ownerId),
      subjectName: owner?.name ?? "Owner",
      subjectCharacter: owner?.character ?? OWNER_DEFAULT_CHARACTER,
      metadata: { isOwner: true },
    }).catch((e) => console.warn("[town-activity] visit failed", e));
    return (
      <TownGame
        ownerCharacter={owner?.character ?? OWNER_DEFAULT_CHARACTER}
        townSlug={town.slug}
      />
    );
  }

  const jar = await cookies();
  const visitor = parseVisitorCookie(jar.get(visitorCookieName(slug))?.value);
  // The cookie carries the code the visitor used at entry — if the owner
  // has rotated since, treat the cookie as expired and re-render the gate.
  if (visitor && visitor.c === town.shareCode) {
    const subjectKey = session
      ? userParticipantKey(session.user.id)
      : guestParticipantKey(visitor.g);
    void recordTownActivity({
      townSlug: town.slug,
      kind: "visit",
      subjectKey,
      subjectName: visitor.n,
      subjectCharacter: visitor.ch,
      metadata: { isOwner: false },
    }).catch((e) => console.warn("[town-activity] visit failed", e));
    return (
      <TownGame
        viewerMode="visitor"
        townSlug={town.slug}
        townName={town.name}
        visitorName={visitor.n}
        visitorCharacter={visitor.ch}
        ownerParticipantKey={userParticipantKey(town.ownerId)}
      />
    );
  }

  return (
    <VisitorGate
      townName={town.name}
      townSlug={town.slug}
      initialName={session?.user.name}
      initialCode={initialInviteCode || undefined}
      signedIn={!!session}
    />
  );
}
