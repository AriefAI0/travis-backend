// Drill server bootstrap: boots the REAL backend (src/index.ts) against the
// travis_test database on travis-postgres with recording v2 enabled. Used only
// for process-kill drills, so drill traffic never touches the live data.
//
// The repo .env may legitimately point at a host that only works for other
// contexts (localhost, live container). This bootstrap therefore takes the
// DATABASE_URL from .env ONLY as a credential template: host becomes
// travis-postgres and the database becomes travis_test. Credentials are never
// printed.
//   docker run -d --name v2-kill-backend --network travis -p 8799:8788 \
//     -e MINIO_ENDPOINT=http://<wsl-ip>:<minio-port> \
//     -v /home/linux_master/travis-backend:/repo -w /repo travis-backend:dev \
//     bun tests/checks/run-v2-drill-server.ts
import { env } from "../../src/config/env";

// parse DATABASE_URL from .env directly (bun's auto-load can be bypassed by
// exported vars; .env is the one source that always rides the mount)
import { readFileSync } from "node:fs";
let template: URL | null = null;
try {
  for (const line of readFileSync("/repo/.env", "utf8").split(/\r?\n/)) {
    const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
    if (match) {
      template = new URL(match[1]!.trim());
      break;
    }
  }
} catch {
  // .env missing: fall back to the environment's own URL
}
if (!template) template = new URL(env.DATABASE_URL);

// drill database: same credentials, travis-postgres host, travis_test database
template.hostname = "travis-postgres";
template.port = "5432";
template.pathname = "/travis_test";
template.protocol = "postgres:";
env.DATABASE_URL = template.toString();

env.RECORDING_V2_ENABLED = true;
console.log("[drill-server] database = travis_test @ travis-postgres");

// index.ts does the full boot: buckets, org, identity, workers, serve
await import("../../src/index");
