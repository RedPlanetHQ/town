// BullMQ worker that processes the hourly aura-regen tick.
//
// One bulk UPDATE per tick:
//   UPDATE "Aura" SET "current" = LEAST("current" + 50, "max"), "updatedAt" = NOW()
//   WHERE "current" < "max"
//
// Atomic, idempotent within a single tick, and skips already-full towns.
// At expected scale (low N of towns) this completes in milliseconds; if
// we ever ship millions of towns we'd chunk this by townId range.
//
// Boot paths mirror events-worker.ts: in-process via instrumentation.ts,
// or standalone via `pnpm worker:aura-regen` if you ever want to scale
// the cron off the HTTP fleet.

import { Worker, type Job } from "bullmq";

import { prisma } from "../lib/db";
import {
  AURA_REGEN_QUEUE_NAME,
  type AuraRegenJobData,
} from "../lib/queue/aura-regen-queue";
import { getRedisConnection } from "../lib/queue/redis";

// How much aura a town regenerates per hourly tick. With the default
// max of 1000 and the token-cost formula (~18 aura for a typical
// 4k/500 turn), a fully-emptied town refills in ~100 hours.
export const AURA_REGEN_AMOUNT = 10;

/** True when the error looks like an RDS-killed-idle-connection
 *  situation. Prisma surfaces these as messages containing "Closed",
 *  "connection lost", "ECONNRESET", or "terminating connection". We
 *  match on any of those and treat the next attempt as fresh. */
function isClosedConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Closed/i.test(msg) ||
    /connection lost/i.test(msg) ||
    /ECONNRESET/.test(msg) ||
    /terminating connection/i.test(msg) ||
    /server closed the connection/i.test(msg)
  );
}

async function runAuraUpdate(): Promise<number> {
  return await prisma.$executeRaw`
    UPDATE "Aura"
    SET "current" = LEAST("current" + ${AURA_REGEN_AMOUNT}, "max"),
        "updatedAt" = NOW()
    WHERE "current" < "max"
  `;
}

async function processJob(job: Job<AuraRegenJobData>): Promise<void> {
  const start = Date.now();
  // RDS aggressively closes idle pool connections (default 5min on most
  // tiers). The hourly cron always finds dead sockets between ticks
  // because nothing else in this worker process is hitting the DB.
  // Retry exactly once after a forced reconnect — if it still fails,
  // bubble so BullMQ records the failure and we get a real signal.
  let updated: number;
  try {
    updated = await runAuraUpdate();
  } catch (err) {
    if (!isClosedConnectionError(err)) throw err;
    console.warn(
      `[aura-regen] tick ${job.id ?? "?"} hit closed connection — reconnecting + retrying`,
    );
    try {
      await prisma.$disconnect();
    } catch {
      // disconnect can throw on an already-dead pool; safe to swallow
      // before we re-connect below.
    }
    await prisma.$connect();
    updated = await runAuraUpdate();
  }
  console.log(
    `[aura-regen] tick ${job.id ?? "?"} → topped up ${updated} town(s) in ${Date.now() - start}ms`,
  );
}

export interface StartedAuraRegenWorker {
  worker: Worker<AuraRegenJobData>;
  stop: () => Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __TOWN_AURA_REGEN_WORKER__: StartedAuraRegenWorker | undefined;
}

export function startAuraRegenWorker(): StartedAuraRegenWorker {
  if (globalThis.__TOWN_AURA_REGEN_WORKER__) {
    return globalThis.__TOWN_AURA_REGEN_WORKER__;
  }

  console.log(`[aura-regen] starting on queue=${AURA_REGEN_QUEUE_NAME}`);

  const worker = new Worker<AuraRegenJobData>(
    AURA_REGEN_QUEUE_NAME,
    processJob,
    {
      connection: getRedisConnection(),
      // Cron ticks run one at a time — there's only ever one ready job
      // per slot, and the underlying UPDATE is a single statement.
      concurrency: 1,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[aura-regen] job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade ?? "?"}): ${err.message}`,
    );
  });

  const stop = async (): Promise<void> => {
    await worker.close();
    globalThis.__TOWN_AURA_REGEN_WORKER__ = undefined;
  };

  const started: StartedAuraRegenWorker = { worker, stop };
  globalThis.__TOWN_AURA_REGEN_WORKER__ = started;
  return started;
}

// Standalone entry point — same pattern as events-worker.ts so an
// operator can run `tsx src/worker/aura-regen-worker.ts` on a long-lived
// host if they ever want to peel cron off the HTTP fleet.
import { fileURLToPath } from "node:url";

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const { stop } = startAuraRegenWorker();
  // Also register the repeatable when running standalone — otherwise
  // the worker would idle forever waiting for a non-existent schedule.
  void import("../lib/queue/aura-regen-queue").then((m) =>
    m.ensureAuraRegenSchedule(),
  );
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[aura-regen] ${signal} - draining`);
    await stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
