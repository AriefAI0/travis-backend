import { env } from "./config/env";
import { app } from "./app";
import { log } from "./lib/logger";
import { ensureBuckets } from "./lib/minio_storage/clients";
import { ensureDefaultOrganization } from "./db/ensure-org";
import { bootstrapBackendIdentity } from "./db/services/recording-upload.service";
import { registerJobHandler, startQueueWorker } from "./lib/jobs/worker";
import { recoveryBoot } from "./features/minio_handler/recovery";
import { startStaleTimer } from "./features/minio_handler/stale";
import { finalizeExhausted, finalizeJob } from "./features/minio_handler/jobs/ffmpeg_finalize";
import { startRecordingFinalizeWorker } from "./features/recordings-v2/jobs/finalize";
import { startIngestSweep } from "./features/recordings-v2/ingest-sweep";
import { startThumbnailSweep } from "./features/recordings-v2/jobs/thumbnails";

// flow: buckets + org > orphan sweep > recover sessions > stale timer + job runner > serve.
// Boot even when MinIO is down — /health/ready is what reports it.
await ensureBuckets().catch((err) => log.error("bucket bootstrap failed", { err: String(err) }));
await ensureDefaultOrganization().catch((err) => log.error("org bootstrap failed", { err: String(err) }));
await bootstrapBackendIdentity().catch((err) => log.error("backend identity bootstrap failed", { err: String(err) }));
await recoveryBoot().catch((err) => log.error("boot recovery failed", { err: String(err) }));
startStaleTimer();
registerJobHandler("finalize", finalizeJob, finalizeExhausted);
startQueueWorker();
startRecordingFinalizeWorker();
startIngestSweep();
// Closed masters without timeline rows: no job table, so the scan is the
// whole retry signal. Best effort, never blocks serving.
startThumbnailSweep();

Bun.serve({ port: env.PORT, fetch: app.fetch });
log.info("travis-backend listening", { port: env.PORT, minio: env.MINIO_ENDPOINT });
