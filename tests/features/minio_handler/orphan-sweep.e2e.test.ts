import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { env } from "../../../src/config/env";
import { s3parts } from "../../../src/lib/minio_storage/s3sdk";
import { startServer, type TestServer } from "../../helpers/server";

// Boot orphan sweep (spec Testing #7): an in-progress MPU with no session row
// is aborted at boot — leaked uploadIds must never linger in the buckets.
const DATA_DIR = "./data/test-e2e-orphan";

let server: TestServer;
let key: string;
let uploadId: string;

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true }); // guarantee a clean tracker

  // leak an MPU directly into the bucket, bypassing the server entirely
  key = `recordings/orphan-e2e-${crypto.randomUUID()}/master.ts`;
  uploadId = await s3parts.initiate(env.BUCKET_MASTER, key);
  const before = await s3parts.listUploads(env.BUCKET_MASTER);
  expect(before.some((u) => u.uploadId === uploadId)).toBe(true);
});

afterAll(async () => {
  await server?.stop().catch(() => {});
  // best-effort: abort if the sweep somehow failed
  await s3parts.abort(env.BUCKET_MASTER, key, uploadId).catch(() => {});
  rmSync(DATA_DIR, { recursive: true, force: true });
});

test("an MPU with no session row is aborted at boot", async () => {
  // boot on the clean DATA_DIR: the sweep runs before serve, so once /health
  // answers the sweep has already decided
  server = await startServer({ DATA_DIR });

  const after = await s3parts.listUploads(env.BUCKET_MASTER);
  expect(after.some((u) => u.uploadId === uploadId)).toBe(false);
}, 60_000);
