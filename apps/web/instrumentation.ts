// Next.js instrumentation hook. Runs once on server startup (both `next
// dev` and `next start`). We use it to spin up the BullMQ events worker
// inside the same process as the HTTP server so a single `pnpm dev` is
// enough to get the full event pipeline running.
//
// Why this is safe:
//   - The worker module guards against duplicate starts via a globalThis
//     singleton, so HMR re-imports don't double-spawn.
//   - We gate on NEXT_RUNTIME === "nodejs" so the worker never tries to
//     boot inside the Edge runtime.
//   - DISABLE_IN_PROCESS_WORKER=1 opts out — set this on serverless
//     deploys (Vercel etc.) and run `pnpm worker` separately on a
//     long-lived host.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISABLE_IN_PROCESS_WORKER === "1") {
    console.log(
      "[instrumentation] DISABLE_IN_PROCESS_WORKER=1 — skipping worker boot",
    );
    return;
  }
  try {
    const { startEventsWorker } = await import("./src/worker/events-worker");
    startEventsWorker();
  } catch (err) {
    console.error(
      "[instrumentation] failed to start events worker:",
      err instanceof Error ? err.message : err,
    );
  }

  // Hourly aura regen. The repeatable lives in Redis (BullMQ keys it
  // by jobName + cron pattern, so re-registering on every boot is a
  // no-op) and the worker consumes one job per tick.
  try {
    const { startAuraRegenWorker } = await import(
      "./src/worker/aura-regen-worker"
    );
    startAuraRegenWorker();
    const { ensureAuraRegenSchedule } = await import(
      "./src/lib/queue/aura-regen-queue"
    );
    await ensureAuraRegenSchedule();
  } catch (err) {
    console.error(
      "[instrumentation] failed to start aura-regen worker:",
      err instanceof Error ? err.message : err,
    );
  }
}
