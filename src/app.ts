import { Hono } from "hono";
import { cors } from "hono/cors";
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
import { taskStructureRoutes } from "./features/task-structure/routes";
import { plannedInspectionRoutes } from "./features/planned-inspections/routes";
import { restrictedAccessRoutes } from "./features/restricted-access/routes";
import { inspectionFormRoutes } from "./features/inspection-forms/routes";
import { importRoutes } from "./features/import/routes";
import { sessionTimelineRoutes } from "./features/session-timeline/routes";
import { reportRoutes } from "./features/reports/routes";
import { editorRoutes } from "./features/reports/editor-page";
import { archiveRoutes } from "./features/archive/routes";
import { auditRoutes } from "./features/audit/routes";
import { authRoutes } from "./features/auth/routes";
import { userRoutes } from "./features/users/routes";
import { permissionRoutes } from "./features/permissions/routes";
import { corsAllowedOrigins, env } from "./config/env";
import { pingDb } from "./db/client";
import { onError } from "./lib/error";
import { minio } from "./lib/minio_storage/clients";

export const app = new Hono();

// request lines on the terminal, hono's default style
if (env.NODE_ENV !== "test") {
  app.use(logger());
}

app.onError(onError);

// One CORS layer for the whole API, before every route. Credentials are on, so
// the bearer header and any cookie survive. `set-auth-token` MUST stay exposed:
// the bearer plugin hands the token back in that header, and a layer that hides
// it breaks sign-in silently.
// The HLS subtree underneath adds its own scoped layer; a request through both
// answers the same origin, so the two never conflict.
app.use(
  "*",
  cors({
    origin: corsAllowedOrigins,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "authorization", "x-report-version"],
    exposeHeaders: ["set-auth-token"],
    maxAge: 600,
  }),
);
// Mounted first: this is where a token comes from, so it cannot sit behind one.
app.route("/", authRoutes());
app.route("/", healthRoutesFor(minio, [{ name: "db", check: pingDb }]));
app.route("/", userRoutes());
app.route("/", permissionRoutes());
app.route("/", auditRoutes());
app.route("/", projectRoutes());
app.route("/", taskStructureRoutes());
app.route("/", plannedInspectionRoutes());
app.route("/", restrictedAccessRoutes());
app.route("/", inspectionFormRoutes());
app.route("/", importRoutes());
app.route("/", sessionTimelineRoutes());
// Report dialog, template download/upload, and the filled docx.
app.route("/", reportRoutes());
// The report editor page, served here so the serve can set its cookie.
app.route("/", editorRoutes());
app.route("/", archiveRoutes());
app.route("/", sessionRoutes());
app.route("/", inspectionRoutes());
app.route("/", recordingRoutes());
app.route("/", resultRoutes());
app.route("/", ingestRoutes());
app.route("/", hlsRoutes());
// Stub only: both routes answer 501 until the export work lands.
app.route("/", exportRoutes());

export type AppType = typeof app;
