import { env } from "./config/env";
import { app } from "./app";
import { log } from "./lib/logger";
import { ensureBuckets } from "./lib/minio_storage/clients";
import { ensureDefaultOrganization } from "./db/ensure-org";
import { startQueueWorker } from "./lib/jobs/worker";
import { startIngestSweep } from "./features/recordings-v2/ingest-sweep";
import { startThumbnailSweep } from "./features/recordings-v2/jobs/thumbnails";

// flow: buckets + org > orphan sweep > job runner > serve.
// Boot even when MinIO is down — /health/ready is what reports it.
await ensureBuckets().catch((err) => log.error("bucket bootstrap failed", { err: String(err) }));
await ensureDefaultOrganization().catch((err) => log.error("org bootstrap failed", { err: String(err) }));
startQueueWorker();
startIngestSweep();
// Closed masters without timeline rows: no job table, so the scan is the
// whole retry signal. Best effort, never blocks serving.
startThumbnailSweep();

Bun.serve({ port: env.PORT, fetch: app.fetch });
log.info("travis-backend listening", { port: env.PORT, minio: env.MINIO_ENDPOINT });
