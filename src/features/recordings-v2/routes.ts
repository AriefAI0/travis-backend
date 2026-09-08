import { Hono } from "hono";
import type { Context } from "hono";
import type { Client } from "minio";
import { z } from "zod";

import type { DbOrTx } from "../../db/client";
import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { parseBody } from "../../lib/parse";
import { ok } from "../../lib/response";
import { minio } from "../../lib/minio_storage/clients";
import { bootstrapBackendIdentity } from "../../db/services/recording-upload.service";
import {
  admitRecording,
  completeSegment,
  getRecordingStatus,
  heartbeatRecording,
  issueSegmentTicket,
  reconcileRecording,
  recoveryCompleteRecording,
  stopRecording,
} from "../../db/services/recording-v2.service";

const uuidSchema = z.uuid();
const indexParamSchema = z.coerce.number().int().min(0);
// descriptors carry sha-256 as 64-char lowercase hex
const checksumSchema = z.string().regex(/^[0-9a-f]{64}$/, "expected 64-char lowercase sha-256 hex");

const admissionSchema = z.object({
  recordingId: z.uuid(),
  kind: z.enum(["master", "clip"]),
  sessionId: z.number().int().positive().optional(),
  startEpoch: z.number().int().positive().optional(),
  resultId: z.number().int().positive().optional(),
  masterVideoId: z.number().int().positive().optional(),
  startOffsetMs: z.number().int().min(0).optional(),
});

const ticketSchema = z.object({
  checksum: checksumSchema,
  sizeBytes: z.number().int().positive(),
});

const reconcileSchema = z.object({
  backendInstanceId: z.uuid(),
  descriptors: z
    .array(
      z.object({
        index: z.number().int().min(0),
        checksum: checksumSchema,
        sizeBytes: z.number().int().nonnegative(),
      })
    )
    .max(500),
});

const stopSchema = z.object({
  finalSegmentIndex: z.number().int().min(-1),
  reason: z.enum(["user", "service_unavailable", "local_io_error", "process_interrupted"]),
});

const recoveryCompleteSchema = z.object({
  finalSegmentIndex: z.number().int().min(0),
});

// path uuid param -> string (validation_error otherwise)
function parseUuidParam(c: Context, name: string): string {
  const parsed = uuidSchema.safeParse(c.req.param(name));
  if (!parsed.success) {
    throw new AppError(400, "validation_error", `${name}: expected uuid`);
  }
  return parsed.data;
}

// path segment-index param -> non-negative int (validation_error otherwise)
function parseIndexParam(c: Context, name: string): number {
  const parsed = indexParamSchema.safeParse(c.req.param(name));
  if (!parsed.success) {
    throw new AppError(400, "validation_error", `${name}: expected non-negative integer`);
  }
  return parsed.data;
}

// Factory form: tests inject the test db and a failing storage client.
// v2 stays feature-gated until the finalization jobs and cutover land.
export const recordingV2Routes = (database?: DbOrTx, storage: Client = minio) => {
  const routes = new Hono();

  // one stable deployment identity per routes instance, bootstrapped on first use
  let identityPromise: Promise<string> | null = null;
  const backendInstanceId = () => {
    identityPromise ??= bootstrapBackendIdentity(database).then((row) => row.instanceId);
    return identityPromise;
  };

  // gate + deployment scope: v2 off by default; token binds the deployment
  routes.use("*", async (c, next) => {
    if (!env.RECORDING_V2_ENABLED) {
      throw new AppError(404, "feature_disabled", "Recording v2 is disabled");
    }
    if (
      env.RECORDING_V2_TOKEN &&
      c.req.header("x-travis-deployment-token") !== env.RECORDING_V2_TOKEN
    ) {
      throw new AppError(401, "deployment_unauthorized", "Missing or invalid deployment token");
    }
    await next();
  });

  // every v2 response carries the protocol version + deployment identity
  const respond = async (c: Context, data: Record<string, unknown>, status: 200 | 201 = 200) =>
    ok(
      c,
      { ...data, protocolVersion: 2, backendInstanceId: await backendInstanceId() },
      status
    );

  // admission: uuid + master/clip domain inputs -> immutable admitted identity
  const handleAdmission = async (c: Context) => {
    const body = await parseBody(c, admissionSchema);
    const instanceId = await backendInstanceId();
    const result = await admitRecording(body, instanceId, database);
    return respond(c, result, result.admitted ? 201 : 200);
  };
  routes.post("/api/v2/recordings", handleAdmission);
  routes.post("/api/v2/recordings/", handleAdmission);

  // capture liveness + storage readiness for the app's stop latch
  routes.post("/api/v2/recordings/:id/heartbeat", async (c) => {
    const recordingId = parseUuidParam(c, "id");
    const state = await heartbeatRecording(recordingId, storage, database);
    return respond(c, state);
  });

  // reserve + presign one segment; stored receipts short-circuit
  routes.post("/api/v2/recordings/:id/segments/:index/ticket", async (c) => {
    const recordingId = parseUuidParam(c, "id");
    const segmentIndex = parseIndexParam(c, "index");
    const body = await parseBody(c, ticketSchema);
    const ticket = await issueSegmentTicket(
      recordingId,
      segmentIndex,
      body.checksum,
      body.sizeBytes,
      storage,
      database
    );
    return respond(c, ticket);
  });

  // verify the stored object against the reservation, commit the receipt
  routes.post("/api/v2/recordings/:id/segments/:index/complete", async (c) => {
    const recordingId = parseUuidParam(c, "id");
    const segmentIndex = parseIndexParam(c, "index");
    const result = await completeSegment(recordingId, segmentIndex, storage, database);
    return respond(c, result);
  });

  // classify a batch of local segment descriptors against the receipt ledger
  routes.post("/api/v2/recordings/:id/reconcile", async (c) => {
    const recordingId = parseUuidParam(c, "id");
    const body = await parseBody(c, reconcileSchema);
    const result = await reconcileRecording(
      recordingId,
      body.backendInstanceId,
      body.descriptors,
      database
    );
    return respond(c, result);
  });

  // idempotent end of capture with the declared final index
  routes.post("/api/v2/recordings/:id/stop", async (c) => {
    const recordingId = parseUuidParam(c, "id");
    const body = await parseBody(c, stopSchema);
    const result = await stopRecording(recordingId, body.finalSegmentIndex, database);
    return respond(c, result);
  });

  // end a late upload batch; finalization scheduling lands with the jobs phase
  routes.post("/api/v2/recordings/:id/recovery-complete", async (c) => {
    const recordingId = parseUuidParam(c, "id");
    const body = await parseBody(c, recoveryCompleteSchema);
    const result = await recoveryCompleteRecording(recordingId, body.finalSegmentIndex, database);
    return respond(c, result);
  });

  // lifecycle read: contiguous stored range, gaps, playback revision
  routes.get("/api/v2/recordings/:id", async (c) => {
    const recordingId = parseUuidParam(c, "id");
    const result = await getRecordingStatus(recordingId, database);
    return respond(c, result);
  });

  return routes;
};
