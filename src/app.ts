import { Hono } from "hono";
import { healthRoutesFor } from "./features/health/routes";
import { minioHandlerRoutes } from "./features/minio_handler/routes";
import { trackerReady } from "./lib/db/minio_tracker";
import { onError } from "./lib/error";
import { minio } from "./lib/minio_storage/clients";

export const app = new Hono();

app.onError(onError);
app.route("/", healthRoutesFor(minio, [{ name: "tracker", check: trackerReady }]));
app.route("/", minioHandlerRoutes);

export type AppType = typeof app;
