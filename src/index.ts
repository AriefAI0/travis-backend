import { env } from "./config/env";
import { app } from "./app";
import { log } from "./lib/logger";
import { ensureBuckets } from "./lib/minio_storage/clients";
import { ensureDefaultOrganization } from "./db/ensure-org";
import { failInterruptedReports } from "./db/services/report.service";
import { startIngestSweep } from "./features/recording/ingest-sweep";
import { startThumbnailSweep } from "./features/recording/jobs/thumbnails";
import editorPage from "./features/reports/editor.html";

// flow: buckets + org > sweeps > serve.
// Boot even when MinIO is down — /health/ready is what reports it.
await ensureBuckets().catch((err) => log.error("bucket bootstrap failed", { err: String(err) }));
await ensureDefaultOrganization().catch((err) => log.error("org bootstrap failed", { err: String(err) }));
startIngestSweep();
// Closed masters without timeline rows: no job table, so the scan is the
// whole retry signal. Best effort, never blocks serving.
startThumbnailSweep();
// A render cut short by a restart leaves its row in `generating`, and the
// dialog polls that row. One pass at boot is enough.
await failInterruptedReports().catch((err) => log.error("report sweep failed", { err: String(err) }));

// The report editor is an HTML bundle: Bun transpiles and bundles its TSX and
// CSS on request, so the page needs no build step. Hono keeps every other path.
Bun.serve({
  port: env.PORT,
  routes: { "/editor/reports/:reportId": editorPage },
  fetch: app.fetch,
});
log.info("travis-backend listening", { port: env.PORT, minio: env.MINIO_ENDPOINT });
