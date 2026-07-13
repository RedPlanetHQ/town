// Write-site helper for PassportStamp.
//
// Called from the town page load whenever a CORE-authenticated viewer
// resolves against a town. Idempotent on `(userId, townId)`: the first
// visit creates the row, subsequent visits bump `lastVisitedAt` and
// increment `visitCount`.
//
// Rule (mirrors the schema comment): don't stamp any of the visitor's
// own owned towns. Owners already show up as `TOWNS OWNED: N` on the
// identity page; stamping their own visits would inflate the collection.

import { prisma } from "@/lib/db";

export async function upsertPassportStamp(opts: {
  userId: string;
  townId: string;
  townOwnerId: string;
}): Promise<void> {
  if (opts.userId === opts.townOwnerId) return;

  await prisma.passportStamp.upsert({
    where: { userId_townId: { userId: opts.userId, townId: opts.townId } },
    create: {
      userId: opts.userId,
      townId: opts.townId,
    },
    update: {
      lastVisitedAt: new Date(),
      visitCount: { increment: 1 },
    },
  });
}
