import { Hono } from "hono";
import type { Client } from "minio";
import { buckets } from "../../config/env";
import { ok } from "../../lib/response";
import { minio } from "../../lib/minio_storage/clients";

export interface DepCheck {
  name: string;
  check: () => boolean | Promise<boolean>;
}

// Factory form: tests inject an unreachable client to exercise the 503 path.
export function healthRoutesFor(client: Client, deps: DepCheck[] = []) {
  const routes = new Hono();

  routes.get("/health", (c) => ok(c, { status: "alive" }));

  routes.get("/health/ready", async (c) => {
    const checks: Record<string, boolean> = {};
    for (const bucket of buckets) {
      try {
        checks[bucket] = await client.bucketExists(bucket);
      } catch {
        checks[bucket] = false;
      }
    }
    for (const dep of deps) checks[dep.name] = await dep.check();
    const ready = Object.values(checks).every(Boolean);
    return ok(c, { ready, checks }, ready ? 200 : 503);
  });

  return routes;
}

export const healthRoutes = healthRoutesFor(minio);
