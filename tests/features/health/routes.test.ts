import { beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { app } from "../../../src/app";
import { healthRoutesFor } from "../../../src/features/health/routes";
import { buildMinioClient, ensureBuckets } from "../../../src/lib/minio_storage/clients";

// /health/ready assumes boot already ensured the buckets; do the same so the 200-path is deterministic.
beforeAll(async () => {
  await ensureBuckets();
});

test("GET /health is always 200, bare JSON outside the envelope", async () => {
  const res = await app.request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "alive" });
});

test("GET /health/ready is 200 when MinIO from env is reachable", async () => {
  const res = await app.request("/health/ready");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { ready: boolean }).ready).toBe(true);
});

test("GET /health/ready is 503 when MinIO is unreachable", async () => {
  const dead = healthRoutesFor(buildMinioClient("http://127.0.0.1:9", "k", "s"));
  const res = await new Hono().route("/", dead).request("/health/ready");
  expect(res.status).toBe(503);
  expect(((await res.json()) as { ready: boolean }).ready).toBe(false);
});
