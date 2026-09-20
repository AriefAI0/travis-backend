import { Hono } from "hono";
import { logger } from "hono/logger";
import { healthRoutesFor } from "./features/health/routes";
import { inspectionRoutes } from "./features/inspections/routes";
import { projectRoutes } from "./features/projects/routes";
import { recordingRoutes } from "./features/recording/routes";
import { resultRoutes } from "./features/results/routes";
import { ingestRoutes } from "./features/recording/ingest-routes";
import { hlsRoutes } from "./features/playback-stream/hls-routes";
import { exportRoutes } from "./features/media-export/routes";
import { sessionRoutes } from "./features/sessions/routes";
import { structureRoutes } from "./features/structure/routes";
import { env } from "./config/env";
import { pingDb } from "./db/client";
import { onError } from "./lib/error";
import { minio } from "./lib/minio_storage/clients";

export const app = new Hono();

// request lines on the terminal, hono's default style
if (env.NODE_ENV !== "test") {
  app.use(logger());
}

app.onError(onError);
app.route("/", healthRoutesFor(minio, [{ name: "db", check: pingDb }]));
app.route("/", projectRoutes());
app.route("/", structureRoutes());
app.route("/", sessionRoutes());
app.route("/", inspectionRoutes());
app.route("/", recordingRoutes());
app.route("/", resultRoutes());
app.route("/", ingestRoutes());
app.route("/", hlsRoutes());
// Stub only: both routes answer 501 until the export work lands.
app.route("/", exportRoutes());

export type AppType = typeof app;
