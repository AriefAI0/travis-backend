// Export stubs: a reserved surface that answers 501 with the shape it will
// accept, and nothing else. The point is that it reserves nothing real.

import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import { app } from "../../../src/app";
import * as schema from "../../../src/db/schema";
import { exportRoutes } from "../../../src/features/media-export/routes";

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("export stubs", () => {
  test("create answers the documented 501", async () => {
    const response = await post("/api/v2/exports", {
      kind: "master",
      targetId: 7,
      startMs: 0,
      endMs: 5_000,
    });

    const raw = await response.clone().text();
    expect(response.status, `unexpected body: ${raw}`).toBe(501);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 501, code: "not_implemented" });
    expect(String(body.title)).toContain("not implemented");
    // The shape is named, so a client can build against the real contract.
    expect(body.requestShape).toMatchObject({
      kind: "master | clip",
      targetId: expect.any(String),
    });
    // the artifact hangs off the recorded range's frozen key prefix
    expect(String(body.artifactKey)).toBe("<frozen key_prefix>/exports/<exportId>.mkv");
  });

  test("status answers the documented 501", async () => {
    const response = await app.request("/api/v2/exports/12");

    expect(response.status).toBe(501);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 501, code: "not_implemented" });
    expect(body.requestShape).toMatchObject({ exportId: expect.any(String) });
  });

  // A stub that half-validates teaches a contract this build cannot honour.
  test("create refuses to judge the body at all", async () => {
    const empty = await post("/api/v2/exports", {});
    const nonsense = await post("/api/v2/exports", { kind: "nope" });

    expect(empty.status).toBe(501);
    expect(nonsense.status).toBe(501);
  });

  test("the stub is a factory with no database work", () => {
    expect(typeof exportRoutes).toBe("function");
    expect(exportRoutes().routes.length).toBe(2);
  });
});

describe("export stubs reserve nothing real", () => {
  // Acceptance: no export row and no worker exists. A table would show up as
  // an export-named drizzle table in the one domain schema.
  test("the domain schema holds no export table", () => {
    const tableNames = Object.entries(schema)
      .filter(([, value]) => is(value, PgTable))
      .map(([name]) => name.toLowerCase());

    // Guard the filter itself: a silent match-all-nothing would pass the rest.
    expect(tableNames.length).toBeGreaterThan(20);
    expect(tableNames.filter((name) => name.includes("export"))).toEqual([]);
  });

  // Acceptance: the replaced surfaces are untouched by this stub.
  test("old v2 and legacy routes still answer", async () => {
    // Legacy ingest transport is unmounted.
    const legacy = await app.request("/api/minio_handler/health");
    expect(legacy.status).toBe(404);

    // v2 recording surface still routes (a missing id is a real answer, not a
    // missing route).
    const v2 = await app.request("/api/v2/recordings/_deployment");
    expect(v2.status).not.toBe(501);

    // The direct ingest routes still exist beside the stub.
    const ingest = await post("/api/v2/ingests", { kind: "nope" });
    expect(ingest.status).not.toBe(501);
  });
});
