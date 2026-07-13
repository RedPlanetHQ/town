// Loads the real, per-user passport data.
//
// Two flavors:
//   - `loadPassportData(userId)`     for signed-in users; keyed off `PassportStamp`.
//   - `loadGuestPassportData(jar)`   for guests; keyed off `TownVisit` for every
//                                    `town-visit-<slug>` cookie present in the
//                                    caller's browser.

import { cookies } from "next/headers";

import { prisma } from "@/lib/db";
import type { PassportData } from "./types";

export async function loadPassportData(userId: string): Promise<PassportData | null> {
  const [user, stamps, ownedCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, passportId: true, createdAt: true },
    }),
    prisma.passportStamp.findMany({
      where: { userId },
      orderBy: { firstVisitedAt: "asc" },
      select: {
        firstVisitedAt: true,
        town: { select: { slug: true, name: true } },
      },
    }),
    prisma.town.count({ where: { ownerId: userId } }),
  ]);

  if (!user) return null;

  return {
    kind: "authed",
    handle: userId,
    displayName: user.name,
    passportId: user.passportId ?? "TP-PENDING",
    issuedAt: user.createdAt,
    townsOwned: ownedCount,
    stamps: stamps.map((s) => ({
      townSlug: s.town.slug,
      townName: s.town.name,
      visitedAt: s.firstVisitedAt,
    })),
  };
}

interface VisitorCookieValue {
  n?: string;      // display name
  g?: string;      // per-town guest id
  c?: string;      // share-code at entry (unused here)
  ch?: string;     // character (unused here)
}

/**
 * Builds a guest passport from every `town-visit-<slug>` cookie in the
 * caller's browser. The display name is the most recent visitor cookie's
 * name; the stamps are the union of `TownVisit` rows for every guest id
 * the browser knows about.
 *
 * Returns `null` when the browser has no visitor cookies at all — the
 * caller renders a zero-stamp provisional passport in that case.
 */
export async function loadGuestPassportData(): Promise<PassportData> {
  const jar = await cookies();
  const visitorCookies = jar.getAll().filter((c) => c.name.startsWith("town-visit-"));

  const guestIds: string[] = [];
  let displayName = "Traveler";
  let earliestName: string | null = null;
  for (const c of visitorCookies) {
    try {
      const parsed = JSON.parse(c.value) as VisitorCookieValue;
      if (parsed.g) guestIds.push(parsed.g);
      if (parsed.n) {
        displayName = parsed.n;
        earliestName ??= parsed.n;
      }
    } catch {
      // ignore malformed
    }
  }

  const stamps = guestIds.length === 0
    ? []
    : await prisma.townVisit
        .findMany({
          where: { viewerKey: { in: guestIds.map((g) => `guest:${g}`) } },
          orderBy: { createdAt: "asc" },
          select: {
            createdAt: true,
            town: { select: { slug: true, name: true } },
          },
        })
        .then((rows) =>
          rows.map((r) => ({
            townSlug: r.town.slug,
            townName: r.town.name,
            visitedAt: r.createdAt,
          })),
        );

  const issuedAt = visitorCookies.length > 0
    ? new Date(Math.min(...stamps.map((s) => s.visitedAt.getTime()), Date.now()))
    : new Date();

  return {
    kind: "guest",
    handle: "guest",
    displayName: earliestName ?? displayName,
    passportId: "TP-GUEST",
    issuedAt,
    townsOwned: 0,
    stamps,
  };
}
