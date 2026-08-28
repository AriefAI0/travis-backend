import { Hono } from "hono";
import type { Client } from "minio";
import { buckets } from "../../config/env";
import { minio } from "../../lib/minio_storage/clients";

export interface DepCheck {
  name: string;
  check: () => boolean | Promise<boolean>;
}

// Factory form: tests inject an unreachable client to exercise the 503 path.
// Root probes stay OUTSIDE the {ok,data} envelope — bare JSON for probes.
export function healthRoutesFor(client: Client, deps: DepCheck[] = []) {
  const routes = new Hono();

  routes.get("/health", (c) => c.json({ status: "alive" }));

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
    return c.json({ ready, checks }, ready ? 200 : 503);
  });

  return routes;
}

export const healthRoutes = healthRoutesFor(minio);
