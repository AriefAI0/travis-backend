import { Hono } from "hono";
import { logger } from "hono/logger";
import { healthRoutesFor } from "./features/health/routes";
import { minioHandlerRoutes } from "./features/minio_handler/routes";
import { inspectionRoutes } from "./features/inspections/routes";
import { projectRoutes } from "./features/projects/routes";
import { recordingRoutes } from "./features/recordings/routes";
import { resultRoutes } from "./features/results/routes";
import { recordingV2Routes } from "./features/recordings-v2/routes";
import { ingestRoutes } from "./features/recordings-v2/ingest-routes";
import { hlsRoutes } from "./features/recordings-v2/hls-routes";
import { sessionRoutes } from "./features/sessions/routes";
import { structureRoutes } from "./features/structure/routes";
import { env } from "./config/env";
import { pingDb } from "./db/client";
import { trackerReady } from "./lib/db/minio_tracker";
import { onError } from "./lib/error";
import { minio } from "./lib/minio_storage/clients";

export const app = new Hono();

// request lines on the terminal, hono's default style
if (env.NODE_ENV !== "test") {
  app.use(logger());
}

app.onError(onError);
app.route("/", healthRoutesFor(minio, [{ name: "db", check: pingDb }, { name: "tracker", check: trackerReady }]));
app.route("/", minioHandlerRoutes);
app.route("/", projectRoutes());
app.route("/", structureRoutes());
app.route("/", sessionRoutes());
app.route("/", inspectionRoutes());
app.route("/", recordingRoutes());
app.route("/", resultRoutes());
app.route("/", recordingV2Routes());
app.route("/", ingestRoutes());
app.route("/", hlsRoutes());

export type AppType = typeof app;
