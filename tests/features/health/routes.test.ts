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

// The root CORS layer, mounted before every route in app.ts.
const RENDERER_ORIGIN = "http://localhost:5173";

test("OPTIONS preflight answers the renderer's origin with credentials", async () => {
  const res = await app.request("/api/v1/projects", {
    method: "OPTIONS",
    headers: {
      origin: RENDERER_ORIGIN,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });

  expect(res.headers.get("access-control-allow-origin")).toBe(RENDERER_ORIGIN);
  expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
});

// The bearer plugin hands the token back in set-auth-token. A layer that hides
// it from the renderer breaks sign-in with no visible error.
test("set-auth-token stays exposed to the renderer", async () => {
  const res = await app.request("/health", { headers: { origin: RENDERER_ORIGIN } });

  expect(res.headers.get("access-control-expose-headers")).toContain("set-auth-token");
});

// `null` is the packaged file:// renderer, and it is on the list.
test("the packaged file:// origin is allowed", async () => {
  const res = await app.request("/health", { headers: { origin: "null" } });

  expect(res.headers.get("access-control-allow-origin")).toBe("null");
});

test("an origin off the list gets no allow-origin header", async () => {
  const res = await app.request("/health", { headers: { origin: "http://evil.example" } });

  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});

// The HLS subtree adds its own scoped layer. Two layers must not each append a
// header: a duplicated value reads back as a joined list, and a browser refuses
// that. The exact-match assertion below is what catches it.
test("the HLS preflight carries one allow-origin, not two", async () => {
  const res = await app.request("/api/v2/hls/master/1/index.m3u8", {
    method: "OPTIONS",
    headers: {
      origin: RENDERER_ORIGIN,
      "access-control-request-method": "GET",
    },
  });

  expect(res.headers.get("access-control-allow-origin")).toBe(RENDERER_ORIGIN);
});
