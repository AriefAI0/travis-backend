import { env } from "./config/env";
import { app } from "./app";
import { log } from "./lib/logger";
import { ensureBuckets } from "./lib/minio_storage/clients";
import { recoveryBoot } from "./features/minio_handler/recovery";
import { startStaleTimer } from "./features/minio_handler/stale";

// flow: buckets > orphan sweep > recover sessions > stale timer > serve.
// Boot even when MinIO is down — /health/ready is what reports it.
await ensureBuckets().catch((err) => log.error("bucket bootstrap failed", { err: String(err) }));
await recoveryBoot().catch((err) => log.error("boot recovery failed", { err: String(err) }));
startStaleTimer();

Bun.serve({ port: env.PORT, fetch: app.fetch });
log.info("travis-backend listening", { port: env.PORT, minio: env.MINIO_ENDPOINT });
