// BullMQ worker that consumes /town-events jobs.
//
// Pipeline per job:
//   1. Resolve the envelope: TownEventRow → typed TownEvent.
//   2. Map CORE userId (envelope.userId) → town User.id via coreUserId.
//   3. Load the user's plot + NPC roster.
//   4. Run the LLM decide() agent → Effect[].
//   5. Persist each effect as a PlotSuggestion (status="pending").
//
// The worker NEVER mutates the plot directly. Suggestions land in the
// sidebar; the player approves/declines from in-game.
//
// Two ways to run it:
//
//   1. Inline with Next — instrumentation.ts calls startEventsWorker() on
//      server startup. Easiest for dev + small deploys. Set
//      DISABLE_IN_PROCESS_WORKER=1 to opt out (e.g. on serverless).
//
//   2. Standalone — `pnpm --filter @town/web worker` runs this file
//      directly. Use this when you want to scale the worker fleet
//      independently of the HTTP server.

import { Worker, type Job } from "bullmq";

import { prisma } from "../lib/db";
import { decide, type NpcRowLite } from "../lib/town/decide";
import { recordSuggestions } from "../lib/town/suggestions";
import {
  EVENTS_QUEUE_NAME,
  type EventJobData,
} from "../lib/queue/events-queue";
import { getRedisConnection } from "../lib/queue/redis";
import type { Plot } from "@town/plot";
import type { TownEvent, TownEventType } from "@town/types";

async function processJob(job: Job<EventJobData>): Promise<void> {
  const eventId = job.data.eventId;
  const row = await prisma.townEventRow.findUnique({
    where: { id: eventId },
  });
  if (!row) return;

  // envelope.userId is CORE's user id; town stores it on User.coreUserId.
  // Users are now keyed on (coreUserId, workspaceId). The town-events
  // queue doesn't carry workspaceId yet, so pick the first matching User
  // — pre-migration rows have workspaceId=null and the OAuth callback's
  // grace path adopts them on next login.
  const user = await prisma.user.findFirst({
    where: { coreUserId: row.userId },
    select: { id: true },
  });
  if (!user) {
    console.warn(
      `[worker] no town user for coreUserId=${row.userId}; skipping event ${eventId}`,
    );
    await markProcessed(eventId);
    return;
  }
  const townUserId = user.id;

  // Pick a town for this user. v1 supports N towns per user but the
  // worker hasn't been extended to route per-town yet; target the user's
  // most-recently-updated town.
  const town = await prisma.town.findFirst({
    where: { ownerId: townUserId },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!town) {
    console.warn(
      `[worker] user ${townUserId} has no town; skipping event ${eventId}`,
    );
    await markProcessed(eventId);
    return;
  }
  const townId = town.id;

  // Rehydrate the loose DB row into the discriminated TownEvent shape.
  // parseEnvelope already validated the payload at write time, so trust
  // it now.
  const envelope = {
    id: row.id,
    userId: row.userId,
    type: row.type as TownEventType,
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload,
    version: 1 as const,
  } as TownEvent;

  const plotRow = await prisma.plotRow.findUnique({
    where: { townId },
  });
  if (!plotRow) {
    console.warn(
      `[worker] town ${townId} has no plot row; skipping event ${eventId}`,
    );
    await markProcessed(eventId);
    return;
  }
  const npcs: NpcRowLite[] = await prisma.npc.findMany({
    where: { townId },
    select: {
      id: true,
      buildingId: true,
      name: true,
      description: true,
      prompt: true,
    },
  });

  const effects = await decide(envelope, {
    plot: plotRow.json as unknown as Plot,
    npcs,
  });

  const written = await recordSuggestions(townUserId, townId, eventId, effects);
  console.log(
    `[worker] ${eventId} ${envelope.type} → ${written} suggestion(s) queued`,
  );
  await markProcessed(eventId);
}

async function markProcessed(eventId: string): Promise<void> {
  await prisma.townEventRow.update({
    where: { id: eventId },
    data: { processedAt: new Date() },
  });
}

export interface StartedWorker {
  worker: Worker<EventJobData>;
  stop: () => Promise<void>;
}

// Module-level singleton so HMR re-imports don't spin up duplicate
// workers (Next dev reloads instrumentation.ts on changes). Also
// declared on globalThis so a server-bundle split that loads this
// module twice still shares state.
declare global {
  // eslint-disable-next-line no-var
  var __TOWN_EVENTS_WORKER__: StartedWorker | undefined;
}

export function startEventsWorker(): StartedWorker {
  if (globalThis.__TOWN_EVENTS_WORKER__) {
    return globalThis.__TOWN_EVENTS_WORKER__;
  }

  const concurrency = Number.parseInt(
    process.env.EVENTS_WORKER_CONCURRENCY ?? "4",
    10,
  );

  console.log(
    `[worker] starting on queue=${EVENTS_QUEUE_NAME} concurrency=${concurrency}`,
  );

  const worker = new Worker<EventJobData>(EVENTS_QUEUE_NAME, processJob, {
    connection: getRedisConnection(),
    concurrency,
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[worker] job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade ?? "?"}): ${err.message}`,
    );
  });

  const stop = async (): Promise<void> => {
    await worker.close();
    globalThis.__TOWN_EVENTS_WORKER__ = undefined;
  };

  const started: StartedWorker = { worker, stop };
  globalThis.__TOWN_EVENTS_WORKER__ = started;
  return started;
}

// Standalone entry point — only fires when this file is executed
// directly (e.g. `tsx src/worker/events-worker.ts`). Behind a check on
// `process.argv[1]` so importing the module (instrumentation.ts) does
// NOT also install signal handlers.
import { fileURLToPath } from "node:url";

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const { stop } = startEventsWorker();
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal} - draining`);
    await stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
