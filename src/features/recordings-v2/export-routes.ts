// Export surface, reserved and stubbed.
//
// A requested MKV export ships in Tasks 26 and 27. Until then these two routes
// answer 501 with the request shape they will accept, so a client can build
// against a real path and fail loudly instead of guessing.
//
// Deliberately absent: no table, no migration, no worker, no claim. The stub
// reads no body and writes nothing, so there is no half-built state to undo
// when the real work lands.

import { Hono } from "hono";

import type { DbOrTx } from "../../db/client";
import { AppError } from "../../lib/error";

// The body POST /api/v2/exports will accept, stated once and returned with
// every stub answer.
const EXPORT_REQUEST_SHAPE = {
  kind: "master | clip",
  targetId: "positive integer: masterVideoId, or clipId when kind is clip",
  startMs: "optional non-negative integer; defaults to the recording start",
  endMs: "optional non-negative integer; defaults to the recording end",
} as const;

// The key the finished artifact will occupy, named so the shape is fixed
// before the work exists. See exportLeaf in lib/minio_storage/paths.
const EXPORT_ARTIFACT_KEY =
  "<orgId>/<projectId>/<sessionId>/<YYYY>/<MM>/<DD>/<master|clips>/<targetId>/exports/export_<exportId>.mkv";

// The status answer GET /api/v2/exports/:exportId will carry.
const EXPORT_STATUS_SHAPE = {
  exportId: "positive integer",
  state: "requested | processing | ready | failed",
  objectKey: "the artifact key above, once ready",
  sizeBytes: "artifact size, once ready",
} as const;

const notImplemented = (what: string, shape: Record<string, unknown>): AppError =>
  new AppError(501, "not_implemented", `${what} is not implemented`, {
    requestShape: shape,
    artifactKey: EXPORT_ARTIFACT_KEY,
  });

// Factory form, matching every other feature route.
export const exportRoutes = (_database?: DbOrTx) => {
  const routes = new Hono();

  // Accepts nothing yet, on purpose: a stub that half-validates teaches a
  // client a contract this build cannot honour.
  routes.post("/api/v2/exports", () => {
    throw notImplemented("Recording export", EXPORT_REQUEST_SHAPE);
  });

  routes.get("/api/v2/exports/:exportId", () => {
    throw notImplemented("Recording export status", EXPORT_STATUS_SHAPE);
  });

  return routes;
};
