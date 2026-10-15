import { env } from "./config/env";
import { app } from "./app";
import { log } from "./lib/logger";
import { ensureBuckets } from "./lib/minio_storage/clients";
import { ensureDefaultOrganization } from "./db/ensure-org";
import { seedFirstAdmin } from "./lib/auth/seed";
import { failInterruptedReports } from "./db/services/report.service";
import { startIngestSweep } from "./features/recording/ingest-sweep";
import { startThumbnailSweep } from "./features/recording/jobs/thumbnails";

// flow: buckets + org > sweeps > serve.
// Boot even when MinIO is down — /health/ready is what reports it.
await ensureBuckets().catch((err) => log.error("bucket bootstrap failed", { err: String(err) }));
await ensureDefaultOrganization().catch((err) => log.error("org bootstrap failed", { err: String(err) }));
// Seeds the first admin, once, while the account table is empty.
await seedFirstAdmin().catch((err) => log.error("admin seed failed", { err: String(err) }));
startIngestSweep();
// Closed masters without timeline rows: no job table, so the scan is the
// whole retry signal. Best effort, never blocks serving.
startThumbnailSweep();
// A render cut short by a restart leaves its row in `generating`, and the
// dialog polls that row. One pass at boot is enough.
await failInterruptedReports().catch((err) => log.error("report sweep failed", { err: String(err) }));

// The report editor page is a route on the app, not a Bun HTML import: the
// serve sets the editor's cookie, and an HTML route value cannot carry one.
Bun.serve({ port: env.PORT, fetch: app.fetch });
log.info("travis-backend listening", { port: env.PORT, minio: env.MINIO_ENDPOINT });
