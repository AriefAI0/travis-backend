import { env } from "./config/env";
import { app } from "./app";
import { log } from "./lib/logger";
import { ensureBuckets } from "./lib/minio_storage/clients";
import { ensureDefaultOrganization } from "./db/ensure-org";
import { registerJobHandler, startQueueWorker } from "./lib/jobs/worker";
import { recoveryBoot } from "./features/minio_handler/recovery";
import { startStaleTimer } from "./features/minio_handler/stale";
import { finalizeJob } from "./features/minio_handler/jobs/ffmpeg_finalize";

// flow: buckets + org > orphan sweep > recover sessions > stale timer + job runner > serve.
// Boot even when MinIO is down — /health/ready is what reports it.
await ensureBuckets().catch((err) => log.error("bucket bootstrap failed", { err: String(err) }));
await ensureDefaultOrganization().catch((err) => log.error("org bootstrap failed", { err: String(err) }));
await recoveryBoot().catch((err) => log.error("boot recovery failed", { err: String(err) }));
startStaleTimer();
registerJobHandler("finalize", finalizeJob);
startQueueWorker();

Bun.serve({ port: env.PORT, fetch: app.fetch });
log.info("travis-backend listening", { port: env.PORT, minio: env.MINIO_ENDPOINT });
