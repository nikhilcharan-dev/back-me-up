import { buildApp } from "./app.js";
import { connectCatalog, closeCatalog } from "./lib/catalogDb.js";
import { config } from "./config/env.js";
import { startAllEnabledCaptures, stopAllCaptures } from "./capture/captureManager.js";
import { startAllSchedules, stopAllSchedules } from "./scheduler/schedulerManager.js";
import { startMetricsCollector, stopMetricsCollector } from "./metrics/collector.js";

async function main() {
  await connectCatalog();
  // Restart-safety: resume every PITR-enabled database's capture from its last
  // persisted resume token, so a process restart loses nothing (within the
  // oplog window) without any manual step.
  await startAllEnabledCaptures();
  // Same restart-safety for cron schedules: base-backup cadence, test-restore
  // cadence, and the retention sweep all resume without a manual step.
  await startAllSchedules();
  startMetricsCollector();
  const app = await buildApp();

  const shutdown = async () => {
    await app.close();
    stopMetricsCollector();
    stopAllSchedules();
    await stopAllCaptures();
    await closeCatalog();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
