// Passport ID generation + backfill utility.
//
// Format: `TP-<year>-<6-digit>`, e.g. `TP-2026-000042`. `year` is the
// user's `createdAt.getUTCFullYear()` so the ID encodes join provenance.
// The 6-digit suffix is random; on the vanishingly rare unique conflict
// we just try again.
//
// This module is idempotent by design: `ensurePassportId(userId)` is
// safe to call on every login. It's a no-op once the user has one.

import { prisma } from "@/lib/db";

const MAX_RETRIES = 8;

function randomSixDigit(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}

export function formatPassportId(year: number, seq: string): string {
  return `TP-${year}-${seq}`;
}

function isPrismaCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err != null && "code" in err && (err as { code?: string }).code === code;
}

/**
 * Assigns a unique `passportId` to `userId` if it doesn't already have one,
 * and returns the value. Idempotent.
 *
 * Race-safe: uses `updateMany` with a compound `where` (`id` + `passportId
 * is null`) so two concurrent callers can't overwrite each other. Loser
 * re-reads and returns the winner's value.
 */
export async function ensurePassportId(userId: string): Promise<string> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { passportId: true, createdAt: true },
  });
  if (!existing) throw new Error(`ensurePassportId: user ${userId} not found`);
  if (existing.passportId) return existing.passportId;

  const year = existing.createdAt.getUTCFullYear();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const candidate = formatPassportId(year, randomSixDigit());
    try {
      const result = await prisma.user.updateMany({
        where: { id: userId, passportId: null },
        data: { passportId: candidate },
      });
      if (result.count === 1) return candidate;

      // Lost the race — someone else assigned it in the meantime. Re-read.
      const race = await prisma.user.findUnique({
        where: { id: userId },
        select: { passportId: true },
      });
      if (race?.passportId) return race.passportId;

      // Row vanished (user deleted between check and update).
      throw new Error(`ensurePassportId: user ${userId} disappeared mid-assign`);
    } catch (err) {
      if (isPrismaCode(err, "P2002")) continue;   // candidate collision — retry
      throw err;
    }
  }
  throw new Error(`ensurePassportId: exhausted ${MAX_RETRIES} attempts for user ${userId}`);
}
