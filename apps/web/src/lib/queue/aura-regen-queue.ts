// Hourly aura regeneration. A BullMQ repeatable seeds a single job at
// the top of every hour; the worker (src/worker/aura-regen-worker.ts)
// runs one bulk UPDATE that bumps every Town's aura by AURA_REGEN_AMOUNT
// (capped at max).
//
// Mirrors the shape of events-queue.ts: lazy queue singleton, errors on
// the registration write are swallowed so a Redis blip during boot
// can't crash the HTTP server.

import { Queue } from "bullmq";

import { getRedisConnection } from "./redis";

export const AURA_REGEN_QUEUE_NAME = "town-aura-regen";
export const AURA_REGEN_JOB_NAME = "regen";

// BullMQ cron expression: minute 0 of every hour. BullMQ keys the
// repeatable on (jobName + pattern) so calling `add(...)` on every
// boot is idempotent — duplicate registrations no-op, and changing
// this pattern naturally invalidates the previous schedule on the
// next deploy.
export const AURA_REGEN_PATTERN = "0 * * * *";

// Job payload is empty — the worker doesn't need any input. Typed as
// `Record<string, never>` instead of `void` so BullMQ's generic stays
// happy.
export type AuraRegenJobData = Record<string, never>;

let _queue: Queue<AuraRegenJobData> | undefined;

function getQueue(): Queue<AuraRegenJobData> {
  if (_queue) return _queue;
  _queue = new Queue<AuraRegenJobData>(AURA_REGEN_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      // Cron ticks are small; keep a short tail for debugging without
      // bloating Redis.
      removeOnComplete: { age: 24 * 60 * 60, count: 50 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  });
  return _queue;
}

// Idempotently registers the hourly repeatable. Safe to call on every
// process startup. If Redis is unreachable we log and move on — the
// next boot will retry registration.
export async function ensureAuraRegenSchedule(): Promise<void> {
  try {
    await getQueue().add(
      AURA_REGEN_JOB_NAME,
      {},
      { repeat: { pattern: AURA_REGEN_PATTERN } },
    );
  } catch (err) {
    console.error(
      "[aura-regen-queue] failed to register schedule:",
      err instanceof Error ? err.message : err,
    );
  }
}
